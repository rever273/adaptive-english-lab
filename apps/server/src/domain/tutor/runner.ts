import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { randomUUID } from "node:crypto";
import type { Db } from "../../db/open.js";
import { RunnerError, type JobRunner, type RunnerContext, type RunnerOutput } from "../../queue/types.js";
import { upsertModelVersion } from "../attempts/transcripts.js";
import type { ChatClient } from "../ai/clients.js";
import { AI_CONFIG_V2, MEASURED_ADDITIONAL_PEAK_MIB, configHashOf } from "../ai/config.js";
import { TUTOR_SYSTEM_V1, ensurePromptVersion } from "../ai/prompts.js";
import { runStructured } from "../ai/structured.js";
import { MAX_OUTPUT_BYTES, schemaVariant, type Validated, type ValidationIssue } from "../ai/validate.js";
import { bankTexts } from "../vocabulary/forms.js";
import { TUTOR_PROMPT } from "./repository.js";

export interface TutorPayload {
  messageId: string;
  slotId: string;
  kind: "more_examples" | "question";
  question: string | null;
}
export interface TutorDraft {
  schema_version: "tutor-v1";
  explanation_ru: string;
  examples_en: string[];
  uncertainty_note: string;
}

export const TUTOR_PARAMS = { numCtx: 4096, temperature: 0.3, seed: 42, numPredict: 900 } as const;
const CYRILLIC = /[Ѐ-ӿ]/;
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();

let compiled: ValidateFunction | null = null;
const validator = (): ValidateFunction => (compiled ??= new Ajv2020({ allErrors: true, strict: true }).compile(schemaVariant("tutor-v1")));

/** Strict: one JSON document, the schema, the right message, Russian explanation, new English examples (never the exercise's own sentences). */
export function validateTutorOutput(text: string, check: { ownSentences: readonly string[] }): Validated<TutorDraft> {
  const bad = (code: string, message: string): Validated<TutorDraft> => ({ ok: false, value: null, issues: [{ code, message }] });
  if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) return bad("TOO_LARGE", "output over 64 KiB");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return bad("NOT_JSON", "the output is not one JSON document");
  }
  if (!validator()(v)) return { ok: false, value: null, issues: (validator().errors ?? []).slice(0, 8).map((e) => ({ code: "SCHEMA", message: `${e.instancePath || "/"} ${e.message ?? ""}` })) };
  const d = v as TutorDraft;
  const issues: ValidationIssue[] = [];
  if (!CYRILLIC.test(d.explanation_ru) || d.explanation_ru.length > 2000) issues.push({ code: "EXPLANATION", message: "explanation_ru must be Russian text of up to 2000 characters" });
  const own = new Set(check.ownSentences.map(norm));
  d.examples_en.forEach((e, i) => {
    if (CYRILLIC.test(e) || e.length > 240) issues.push({ code: "EXAMPLE_EN", message: `examples_en/${i} must be one short English sentence` });
    else if (own.has(norm(e))) issues.push({ code: "EXAMPLE_COPIED", message: `examples_en/${i} repeats a sentence of the exercise; give a new one` });
  });
  if (d.uncertainty_note.length > 500 || (d.uncertainty_note !== "" && !CYRILLIC.test(d.uncertainty_note))) issues.push({ code: "NOTE", message: "uncertainty_note is empty or short Russian text" });
  return issues.length === 0 ? { ok: true, value: d, issues: [] } : { ok: false, value: null, issues };
}

export interface TutorRunnerOptions {
  db: Db;
  chat: ChatClient;
  installedDigest: (tag: string) => Promise<string | null>;
  runtimeVersion: () => Promise<string>;
  deps: { now: () => Date; newId?: () => string };
  sleep?: (ms: number) => Promise<void>;
}

/** Background tutor answer. Context is the exercise, its approved rule and skill ids; it can only append a DRAFT message and touches no score. */
export class TutorJobRunner implements JobRunner<TutorPayload> {
  readonly kind = "tutor" as const;
  private modelVersionId: string | null = null;
  constructor(private readonly o: TutorRunnerOptions) {}

  private get pinned() {
    return AI_CONFIG_V2.analysis;
  }

  async prepare(): Promise<{ ok: boolean; reason?: string }> {
    const m = this.pinned;
    const digest = await this.o.installedDigest(m.tag);
    if (digest === null) return { ok: false, reason: "model_server_or_model_unavailable" };
    if (digest !== m.digest) return { ok: false, reason: "digest_drift" };
    const id = upsertModelVersion(this.o.db, this.o.deps.newId ?? randomUUID, { tag: m.tag, digest, runtime: "ollama", runtimeVersion: await this.o.runtimeVersion(), parameters: { num_ctx: TUTOR_PARAMS.numCtx, temperature: TUTOR_PARAMS.temperature, seed: TUTOR_PARAMS.seed, num_predict: TUTOR_PARAMS.numPredict } });
    const peak = MEASURED_ADDITIONAL_PEAK_MIB[m.tag];
    if (peak !== undefined) {
      this.o.db
        .prepare("INSERT OR IGNORE INTO gpu_profiles(id, model_version_id, config_hash, measured_peak_mib, timings_json, validated_at) VALUES (?,?,?,?,?,?)")
        .run((this.o.deps.newId ?? randomUUID)(), id, configHashOf(TUTOR_PARAMS), peak, JSON.stringify({ source: "TASK_002/TASK_008 real measurements (ctx 4096)", note: "additional peak above the desktop baseline" }), this.o.deps.now().toISOString());
    }
    ensurePromptVersion(this.o.db, TUTOR_PROMPT, JSON.stringify(schemaVariant("tutor-v1")));
    this.modelVersionId = id;
    return { ok: true };
  }

  ownedModels(): string[] {
    return [this.pinned.tag];
  }
  profileKey() {
    return this.modelVersionId ? { modelVersionId: this.modelVersionId, configHash: configHashOf(TUTOR_PARAMS) } : null;
  }

  async run(ctx: RunnerContext<TutorPayload>): Promise<RunnerOutput> {
    const m = this.pinned;
    const { messageId, slotId, kind, question } = ctx.job.payload;
    const installed = await this.o.installedDigest(m.tag);
    if (installed !== m.digest) throw new RunnerError("model_digest_mismatch", `installed digest of ${m.tag} differs from the pinned one`, false);
    const row = this.o.db
      .prepare("SELECT er.type AS type, er.content_json AS c, ss.question_id AS q FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.id = ?")
      .get(slotId) as { type: string; c: string; q: string | null } | undefined;
    if (!row) throw new RunnerError("slot_missing", "unknown slot", false);
    const content = JSON.parse(row.c) as { prompt_en: string; explanation_ru: string; target_skill: string; additional_skills?: string[]; payload: Record<string, any> };
    const own = [content.prompt_en, ...bankTexts(content, row.type)];
    const user = JSON.stringify({
      message_id: messageId,
      request: kind === "more_examples" ? "Give new examples of this rule." : "Answer the learner's question about this rule.",
      learner_question: question,
      verified_rule_ru: content.explanation_ru,
      exercise_prompt_en: content.prompt_en,
      skills: [content.target_skill, ...(content.additional_skills ?? [])],
    });
    const result = await runStructured<TutorDraft>({
      client: this.o.chat,
      model: m.tag,
      messages: [
        { role: "system", content: TUTOR_SYSTEM_V1 },
        { role: "user", content: user },
      ],
      format: schemaVariant("tutor-v1"),
      options: { num_ctx: TUTOR_PARAMS.numCtx, num_predict: TUTOR_PARAMS.numPredict, temperature: TUTOR_PARAMS.temperature, seed: TUTOR_PARAMS.seed },
      validate: (text) => validateTutorOutput(text, { ownSentences: own }),
      signal: ctx.signal,
      sleep: this.o.sleep,
    });
    if (!result.ok) throw new RunnerError(result.code, result.issues.map((i) => `${i.code}: ${i.message}`).join("; ").slice(0, 400), result.code === "transport_failed");
    const d = result.value;
    return {
      schemaVersion: "tutor-v1",
      output: d,
      metrics: { calls: result.usage.calls, repaired: result.usage.repaired, stats: result.usage.stats },
      alsoCommit: (db) => {
        db.prepare("INSERT INTO tutor_messages(id, thread_id, role, kind, source, text, context_json, job_id, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(
          (this.o.deps.newId ?? randomUUID)(),
          slotId,
          "assistant",
          kind,
          "model",
          d.explanation_ru,
          JSON.stringify({ examples_en: d.examples_en, uncertainty_note: d.uncertainty_note, model: m.tag, prompt: TUTOR_PROMPT, in_reply_to: messageId }),
          ctx.job.id,
          "draft",
          this.o.deps.now().toISOString(),
        );
      },
    };
  }
}
