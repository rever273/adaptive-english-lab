import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { randomUUID } from "node:crypto";
import type { Db } from "../../db/open.js";
import { RunnerError, type JobRunner, type RunnerContext, type RunnerOutput } from "../../queue/types.js";
import { upsertModelVersion } from "../attempts/transcripts.js";
import type { ChatClient } from "../ai/clients.js";
import { AI_CONFIG_V3, RESIDENT_NUM_CTX, MEASURED_ADDITIONAL_PEAK_MIB, configHashOf } from "../ai/config.js";
import { VOCABULARY_SYSTEM_V4, ensurePromptVersion } from "../ai/prompts.js";
import { runStructured } from "../ai/structured.js";
import { MAX_OUTPUT_BYTES, schemaVariant, type Validated, type ValidationIssue } from "../ai/validate.js";
import { POS_VALUES, VOCAB_PROMPT } from "./repository.js";
import { bankTexts, countOccurrences, matchForms } from "./forms.js";
import type { LexiconHint } from "./lexiconHint.js";

export interface VocabularyPayload {
  entryId: string;
  /** the entry's user_revision when the job was queued */
  expectedUserRevision: number;
  /** D64: the word already has a draft; only its CEFR level is missing */
  levelOnly?: boolean;
}
export interface VocabularyDraft {
  schema_version: "vocabulary-v3";
  entry_id: string;
  translation_ru: string;
  part_of_speech: string;
  cefr_level: "A1" | "A2" | "B1" | "B2" | "C1" | "C2";
  example_en: string;
  collocations: string[];
  /** reference facts (D69): cleaned by `cleanReference`, so a field the model got wrong is empty rather than an error */
  transcription: string;
  definition_ru: string;
  synonyms: string[];
  irregular_forms: string[];
}

export const VOCAB_PARAMS = { numCtx: RESIDENT_NUM_CTX, temperature: 0.2, seed: 42, numPredict: 768 } as const;
const CYRILLIC = /[Ѐ-ӿ]/;

let compiled: ValidateFunction | null = null;
const validator = (): ValidateFunction => (compiled ??= new Ajv2020({ allErrors: true, strict: true }).compile(schemaVariant("vocabulary-v3")));

/** The reference fields are lenient on purpose: anything that does not look right is dropped, never a reason to lose the translation. */
export function cleanReference<T extends Pick<VocabularyDraft, "transcription" | "definition_ru" | "synonyms" | "irregular_forms">>(d: T, lemma: string): T {
  const english = (s: string, max: number): boolean => s.length > 0 && s.length <= max && !CYRILLIC.test(s);
  let ipa = d.transcription.trim().replace(/^\/(.*)\/$/, "[$1]");
  if (!ipa.startsWith("[")) ipa = `[${ipa}]`;
  if (ipa.length > 52 || ipa.length < 3 || CYRILLIC.test(ipa) || /[\s]{2}|\[\s*\]/.test(ipa)) ipa = "";
  const synonyms = [...new Set(d.synonyms.map((s) => s.trim()).filter((s) => english(s, 40) && s.toLowerCase() !== lemma.toLowerCase()))].slice(0, 5);
  const forms = d.irregular_forms.map((s) => s.trim());
  const definition = d.definition_ru.trim();
  return { ...d, transcription: ipa, definition_ru: CYRILLIC.test(definition) && definition.length <= 300 ? definition : "", synonyms, irregular_forms: forms.length === 3 && forms.every((f) => english(f, 30)) ? forms : [] };
}

/** Strict and boring: one JSON document, the schema, the right entry, Russian where Russian belongs, English where English belongs. */
export function validateVocabularyOutput(text: string, check: { entryId: string; forms: readonly string[]; lemma?: string }): Validated<VocabularyDraft> {
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
  return issues.length === 0 ? { ok: true, value: cleanReference({ ...d, part_of_speech: d.part_of_speech.toLowerCase() }, check.lemma ?? ""), issues: [] } : { ok: false, value: null, issues };
}

export interface VocabularyRunnerOptions {
  db: Db;
  chat: ChatClient;
  installedDigest: (tag: string) => Promise<string | null>;
  runtimeVersion: () => Promise<string>;
  /** the optional old word list (D69); absent or without the word means no hint */
  hints?: { lookup(lemma: string): Promise<LexiconHint | null> };
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
    return AI_CONFIG_V3.analysis;
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
        .run((this.o.deps.newId ?? randomUUID)(), id, configHashOf(VOCAB_PARAMS), peak, JSON.stringify({ source: "TASK_023 nvidia-smi measurement of gemma4:12b at num_ctx 8192 (gemma4:12b entry in MEASURED_ADDITIONAL_PEAK_MIB) (ctx 8192)", note: "additional peak above the desktop baseline" }), this.o.deps.now().toISOString());
    }
    ensurePromptVersion(this.o.db, VOCAB_PROMPT, JSON.stringify(schemaVariant("vocabulary-v3")));
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
    const drafted = this.o.db.prepare("SELECT 1 FROM vocabulary_revisions WHERE entry_id = ? AND source = 'model' AND based_on_user_rev = ?").get(entryId, expectedUserRevision) !== undefined;
    const hasLevel = this.o.db.prepare("SELECT 1 FROM vocabulary_levels WHERE entry_id = ?").get(entryId) !== undefined;
    const hasLexicon = this.o.db.prepare("SELECT 1 FROM vocabulary_lexicon WHERE entry_id = ?").get(entryId) !== undefined;
    if ((drafted || ctx.job.payload.levelOnly) && hasLevel && hasLexicon) {
      return { schemaVersion: "vocabulary-v2", output: { entryId, skipped: "already_drafted" }, metrics: { calls: 0 } };
    }
    const writeRevision = !drafted && !ctx.job.payload.levelOnly; // a level-only job never adds a second text draft
    const surface = JSON.parse(e.forms) as string[];
    const forms = matchForms(e.lemma, surface);
    // up to three real sentences that contain the word (data, never instructions): FIRST the task where the learner met it (D63), then the bank
    const context: string[] = [];
    for (const r of this.o.db
      .prepare(
        "SELECT er.type AS type, er.content_json AS c FROM vocabulary_encounters ve JOIN exercise_revisions er ON er.id = ve.revision_id WHERE ve.entry_id = ? GROUP BY ve.revision_id ORDER BY MAX(ve.kind = 'displayed') DESC, MAX(ve.created_at) DESC LIMIT 6",
      )
      .all(entryId) as Array<{ type: string; c: string }>) {
      for (const t of bankTexts(JSON.parse(r.c) as { prompt_en: string; payload: Record<string, any> }, r.type)) {
        if (context.length < 3 && countOccurrences(t, forms) > 0 && t.length <= 240) context.push(t);
      }
    }
    const hint = (await this.o.hints?.lookup(e.lemma)) ?? null;
    const referenceHint = hint && { part_of_speech: hint.partOfSpeech, transcription: hint.transcription, definition_ru: hint.definitionRu, synonyms: hint.synonyms, irregular_forms: hint.irregularForms, translations_ru: hint.translationsRu };
    const user = JSON.stringify({ entry_id: entryId, word: e.lemma, selected_forms: surface, met_in_sentence: context[0] ?? null, context_sentences: context, allowed_parts_of_speech: POS_VALUES, reference_hint: referenceHint });
    const result = await runStructured<VocabularyDraft>({
      client: this.o.chat,
      model: m.tag,
      messages: [
        { role: "system", content: VOCABULARY_SYSTEM_V4 },
        { role: "user", content: user },
      ],
      format: schemaVariant("vocabulary-v3"),
      options: { num_ctx: VOCAB_PARAMS.numCtx, num_predict: VOCAB_PARAMS.numPredict, temperature: VOCAB_PARAMS.temperature, seed: VOCAB_PARAMS.seed + ctx.job.retryCount },
      validate: (text) => validateVocabularyOutput(text, { entryId, forms, lemma: e.lemma }),
      signal: ctx.signal,
      sleep: this.o.sleep,
    });
    let d: VocabularyDraft;
    let exampleOmitted = false;
    if (!result.ok) {
      // The response has passed the complete schema and every check except example use of the target word.
      // Keep the independently validated fields as an explicitly partial draft; never show the invalid example.
      const raw = result.usage.rawOutputs.at(-1);
      const checked = raw ? validateVocabularyOutput(raw, { entryId, forms, lemma: e.lemma }) : null;
      if (result.code === "failed_validation" && checked && !checked.ok && checked.issues.length === 1 && checked.issues[0]!.code === "EXAMPLE_WITHOUT_WORD") {
        const candidate = JSON.parse(raw!) as VocabularyDraft;
        d = cleanReference({ ...candidate, part_of_speech: candidate.part_of_speech.toLowerCase(), example_en: "" }, e.lemma);
        exampleOmitted = true;
      } else {
        throw new RunnerError(result.code, result.issues.map((i) => `${i.code}: ${i.message}`).join("; ").slice(0, 400), result.code === "transport_failed" || result.code === "failed_validation", result.issues.map(i => i.code));
      }
    } else d = result.value;
    return {
      schemaVersion: exampleOmitted ? "vocabulary-partial-v1" : "vocabulary-v3",
      output: exampleOmitted ? { ...d, schema_version: "vocabulary-partial-v1", incomplete_fields: ["example_en"], issue_codes: ["EXAMPLE_WITHOUT_WORD"] } : d,
      metrics: { calls: result.usage.calls, repaired: result.usage.repaired, seed: VOCAB_PARAMS.seed + ctx.job.retryCount, stats: result.usage.stats },
      alsoCommit: (db) => {
        const jr = db.prepare("SELECT id FROM job_results WHERE job_id = ?").get(ctx.job.id) as { id: string };
        if (!db.prepare("SELECT 1 FROM vocabulary_levels WHERE entry_id = ?").get(entryId)) db.prepare("INSERT INTO vocabulary_levels(id, entry_id, level, source, status, job_result_id, created_at) VALUES (?,?,?,?,?,?,?)").run((this.o.deps.newId ?? randomUUID)(), entryId, d.cefr_level, "model", "draft", jr.id, this.o.deps.now().toISOString());
        if (!hasLexicon) {
          db.prepare(
            "INSERT INTO vocabulary_lexicon(id, entry_id, transcription, definition_ru, synonyms_json, irregular_forms_json, frequency, hint_used, source, status, job_result_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
          ).run((this.o.deps.newId ?? randomUUID)(), entryId, d.transcription, d.definition_ru, JSON.stringify(d.synonyms), JSON.stringify(d.irregular_forms), hint?.frequency ?? null, hint ? 1 : 0, "model", "validated", jr.id, this.o.deps.now().toISOString());
        }
        if (!writeRevision) return;
        const next = (db.prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS n FROM vocabulary_revisions WHERE entry_id = ?").get(entryId) as { n: number }).n;
        db.prepare(
          "INSERT INTO vocabulary_revisions(id, entry_id, revision, translation_ru, part_of_speech, example_en, collocations_json, source, status, user_edited, based_on_user_rev, job_result_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run((this.o.deps.newId ?? randomUUID)(), entryId, next, d.translation_ru, d.part_of_speech, d.example_en, JSON.stringify(d.collocations), "model", "draft", 0, expectedUserRevision, jr.id, this.o.deps.now().toISOString());
      },
    };
  }
}
