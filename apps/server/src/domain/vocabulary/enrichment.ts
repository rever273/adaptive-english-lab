import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { randomUUID } from "node:crypto";
import type { Db } from "../../db/open.js";
import { RunnerError, type JobRunner, type RunnerContext, type RunnerOutput } from "../../queue/types.js";
import { upsertModelVersion } from "../attempts/transcripts.js";
import type { ChatClient } from "../ai/clients.js";
import { AI_CONFIG_V2, MEASURED_ADDITIONAL_PEAK_MIB, configHashOf } from "../ai/config.js";
import { VOCABULARY_SYSTEM_V1, ensurePromptVersion } from "../ai/prompts.js";
import { runStructured } from "../ai/structured.js";
import { MAX_OUTPUT_BYTES, schemaVariant, type Validated, type ValidationIssue } from "../ai/validate.js";
import { POS_VALUES, VOCAB_PROMPT } from "./repository.js";
import { bankTexts, countOccurrences, matchForms } from "./forms.js";

export interface VocabularyPayload {
  entryId: string;
  /** the entry's user_revision when the job was queued */
  expectedUserRevision: number;
}
export interface VocabularyDraft {
  schema_version: "vocabulary-v1";
  entry_id: string;
  translation_ru: string;
  part_of_speech: string;
  example_en: string;
  collocations: string[];
}

export const VOCAB_PARAMS = { numCtx: 4096, temperature: 0.2, seed: 42, numPredict: 512 } as const;
const CYRILLIC = /[Ѐ-ӿ]/;

let compiled: ValidateFunction | null = null;
const validator = (): ValidateFunction => (compiled ??= new Ajv2020({ allErrors: true, strict: true }).compile(schemaVariant("vocabulary-v1")));

/** Strict and boring: one JSON document, the schema, the right entry, Russian where Russian belongs, English where English belongs. */
export function validateVocabularyOutput(text: string, check: { entryId: string; forms: readonly string[] }): Validated<VocabularyDraft> {
  const bad = (code: string, message: string): Validated<VocabularyDraft> => ({ ok: false, value: null, issues: [{ code, message }] });
  if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) return bad("TOO_LARGE", "output over 64 KiB");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return bad("NOT_JSON", "the output is not one JSON document");
  }
  if (!validator()(v)) return { ok: false, value: null, issues: (validator().errors ?? []).slice(0, 8).map((e) => ({ code: "SCHEMA", message: `${e.instancePath || "/"} ${e.message ?? ""}` })) };
  const d = v as VocabularyDraft;
  const issues: ValidationIssue[] = [];
  if (d.entry_id !== check.entryId) issues.push({ code: "WRONG_ENTRY", message: "entry_id is not the one asked about" });
  if (!CYRILLIC.test(d.translation_ru) || d.translation_ru.length > 300) issues.push({ code: "TRANSLATION", message: "translation_ru must be a short Russian text" });
  if (!(POS_VALUES as readonly string[]).includes(d.part_of_speech.toLowerCase())) issues.push({ code: "POS", message: `part_of_speech must be one of ${POS_VALUES.join(", ")}` });
  if (CYRILLIC.test(d.example_en) || d.example_en.length > 400) issues.push({ code: "EXAMPLE", message: "example_en must be one short English sentence" });
  else if (countOccurrences(d.example_en, check.forms) === 0) issues.push({ code: "EXAMPLE_WITHOUT_WORD", message: "the example must use the word or one of its forms" });
  if (d.collocations.length > 10 || d.collocations.some((c) => CYRILLIC.test(c) || c.length > 80)) issues.push({ code: "COLLOCATIONS", message: "collocations are up to 10 short English phrases" });
  return issues.length === 0 ? { ok: true, value: { ...d, part_of_speech: d.part_of_speech.toLowerCase() }, issues: [] } : { ok: false, value: null, issues };
}

export interface VocabularyRunnerOptions {
  db: Db;
  chat: ChatClient;
  installedDigest: (tag: string) => Promise<string | null>;
  runtimeVersion: () => Promise<string>;
  deps: { now: () => Date; newId?: () => string };
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Background DRAFT for a saved word (spec/06). It goes through the single GPU dispatcher, is validated, and is stored as a model revision whose
 * status is `draft`. It can only add a revision: it never edits the entry or the learner's own text, and if the learner edited meanwhile the
 * draft is marked as predating that edit and still only fills fields the learner left empty (see `view`).
 */
export class VocabularyJobRunner implements JobRunner<VocabularyPayload> {
  readonly kind = "vocabulary_enrichment" as const;
  private modelVersionId: string | null = null;
  constructor(private readonly o: VocabularyRunnerOptions) {}

  private get pinned() {
    return AI_CONFIG_V2.analysis;
  }

  async prepare(): Promise<{ ok: boolean; reason?: string }> {
    const m = this.pinned;
    const digest = await this.o.installedDigest(m.tag);
    if (digest === null) return { ok: false, reason: "model_server_or_model_unavailable" };
    if (digest !== m.digest) return { ok: false, reason: "digest_drift" };
    const id = upsertModelVersion(this.o.db, this.o.deps.newId ?? randomUUID, { tag: m.tag, digest, runtime: "ollama", runtimeVersion: await this.o.runtimeVersion(), parameters: { num_ctx: VOCAB_PARAMS.numCtx, temperature: VOCAB_PARAMS.temperature, seed: VOCAB_PARAMS.seed, num_predict: VOCAB_PARAMS.numPredict } });
    const peak = MEASURED_ADDITIONAL_PEAK_MIB[m.tag];
    if (peak !== undefined) {
      this.o.db
        .prepare("INSERT OR IGNORE INTO gpu_profiles(id, model_version_id, config_hash, measured_peak_mib, timings_json, validated_at) VALUES (?,?,?,?,?,?)")
        .run((this.o.deps.newId ?? randomUUID)(), id, configHashOf(VOCAB_PARAMS), peak, JSON.stringify({ source: "TASK_002/TASK_008 real measurements (ctx 4096)", note: "additional peak above the desktop baseline" }), this.o.deps.now().toISOString());
    }
    ensurePromptVersion(this.o.db, VOCAB_PROMPT, JSON.stringify(schemaVariant("vocabulary-v1")));
    this.modelVersionId = id;
    return { ok: true };
  }

  ownedModels(): string[] {
    return [this.pinned.tag];
  }
  profileKey() {
    return this.modelVersionId ? { modelVersionId: this.modelVersionId, configHash: configHashOf(VOCAB_PARAMS) } : null;
  }

  async run(ctx: RunnerContext<VocabularyPayload>): Promise<RunnerOutput> {
    const m = this.pinned;
    const { entryId, expectedUserRevision } = ctx.job.payload;
    const installed = await this.o.installedDigest(m.tag);
    if (installed !== m.digest) throw new RunnerError("model_digest_mismatch", `installed digest of ${m.tag} differs from the pinned one`, false);
    const e = this.o.db.prepare("SELECT id, lemma, surface_forms_json AS forms FROM vocabulary_entries WHERE id = ?").get(entryId) as { id: string; lemma: string; forms: string } | undefined;
    if (!e) throw new RunnerError("entry_missing", "unknown word", false);
    if (this.o.db.prepare("SELECT 1 FROM vocabulary_revisions WHERE entry_id = ? AND source = 'model' AND based_on_user_rev = ?").get(entryId, expectedUserRevision)) {
      return { schemaVersion: "vocabulary-v1", output: { entryId, skipped: "already_drafted" }, metrics: { calls: 0 } };
    }
    const surface = JSON.parse(e.forms) as string[];
    const forms = matchForms(e.lemma, surface);
    // up to three real sentences from the approved bank that contain the word (data, never instructions)
    const context: string[] = [];
    for (const r of this.o.db.prepare("SELECT er.type AS type, er.content_json AS c FROM vocabulary_encounters ve JOIN exercise_revisions er ON er.id = ve.revision_id WHERE ve.entry_id = ? AND ve.kind = 'bank' GROUP BY ve.revision_id LIMIT 6").all(entryId) as Array<{ type: string; c: string }>) {
      for (const t of bankTexts(JSON.parse(r.c) as { prompt_en: string; payload: Record<string, any> }, r.type)) {
        if (context.length < 3 && countOccurrences(t, forms) > 0 && t.length <= 240) context.push(t);
      }
    }
    const user = JSON.stringify({ entry_id: entryId, word: e.lemma, selected_forms: surface, context_sentences: context, allowed_parts_of_speech: POS_VALUES });
    const result = await runStructured<VocabularyDraft>({
      client: this.o.chat,
      model: m.tag,
      messages: [
        { role: "system", content: VOCABULARY_SYSTEM_V1 },
        { role: "user", content: user },
      ],
      format: schemaVariant("vocabulary-v1"),
      options: { num_ctx: VOCAB_PARAMS.numCtx, num_predict: VOCAB_PARAMS.numPredict, temperature: VOCAB_PARAMS.temperature, seed: VOCAB_PARAMS.seed },
      validate: (text) => validateVocabularyOutput(text, { entryId, forms }),
      signal: ctx.signal,
      sleep: this.o.sleep,
    });
    if (!result.ok) throw new RunnerError(result.code, result.issues.map((i) => `${i.code}: ${i.message}`).join("; ").slice(0, 400), result.code === "transport_failed");
    const d = result.value;
    return {
      schemaVersion: "vocabulary-v1",
      output: d,
      metrics: { calls: result.usage.calls, repaired: result.usage.repaired, stats: result.usage.stats },
      alsoCommit: (db) => {
        const jr = db.prepare("SELECT id FROM job_results WHERE job_id = ?").get(ctx.job.id) as { id: string };
        const next = (db.prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS n FROM vocabulary_revisions WHERE entry_id = ?").get(entryId) as { n: number }).n;
        db.prepare(
          "INSERT INTO vocabulary_revisions(id, entry_id, revision, translation_ru, part_of_speech, example_en, collocations_json, source, status, user_edited, based_on_user_rev, job_result_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run((this.o.deps.newId ?? randomUUID)(), entryId, next, d.translation_ru, d.part_of_speech, d.example_en, JSON.stringify(d.collocations), "model", "draft", 0, expectedUserRevision, jr.id, this.o.deps.now().toISOString());
      },
    };
  }
}
