import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../../db/open.js";
import { OllamaClient } from "../../adapters/gpu/ollamaClient.js";
import type { Job } from "../../queue/jobs.js";
import { RunnerError, type JobRunner, type RunnerContext, type RunnerOutput } from "../../queue/types.js";
import { latestAssessment, writeAssessmentRevision, type AttemptRow } from "../attempts/assessments.js";
import { resolveTargetSkillKey, loadSlotContext } from "../attempts/context.js";
import type { AttemptDeps, AssessmentDecision, Confirmation } from "../attempts/ports.js";
import { upsertModelVersion } from "../attempts/transcripts.js";
import { AI_CONFIG_V3, MEASURED_ADDITIONAL_PEAK_MIB, configHashOf, type AiConfig } from "./config.js";
import type { ChatClient } from "./clients.js";
import { TransportError } from "./clients.js";
import { buildAnalysisUserMessageV2, ANALYSIS_SYSTEM_V3, ensurePromptVersion, type AnalysisContext } from "./prompts.js";
import { runStructured } from "./structured.js";
import { schemaVariant, validateAiOutput, isSchemaValidOutput, type AnalysisV2 } from "./validate.js";

export interface AnalysisPayload {
  attemptId: string;
  assessmentId: string;
}

export interface AnalysisRunnerOptions {
  db: Db;
  chat: ChatClient;
  /** installed digest of a tag, or null when the model server cannot say (reads /api/tags) */
  installedDigest: (tag: string) => Promise<string | null>;
  runtimeVersion: () => Promise<string>;
  config?: AiConfig;
  deps: Pick<AttemptDeps, "now" | "newId">;
  sleep?: (ms: number) => Promise<void>;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Full-text analysis of a free written answer by the local model (gemma4:12b, D67) (spec/06). Output is a validated DRAFT: it becomes a model-sourced,
 * tentative assessment revision plus tentative findings and an ai_annotation - never confirmed, never Mastery evidence. Everything
 * (job result, annotation, revision, findings) commits in ONE transaction under the fencing token or not at all. The model server
 * is called only here, only through the dispatcher, with no tools.
 */
export class AnalysisJobRunner implements JobRunner<AnalysisPayload> {
  readonly kind = "free_text_analysis" as const;
  private readonly cfg: AiConfig;
  private modelVersionId: string | null = null;

  constructor(private readonly o: AnalysisRunnerOptions) {
    this.cfg = o.config ?? AI_CONFIG_V3;
  }

  /** Registers the model identity and its measured profile (idempotent). Called at startup; failure leaves admission at profile_unknown. */
  async prepare(): Promise<{ ok: boolean; reason?: string }> {
    const m = this.cfg.analysis;
    const digest = await this.o.installedDigest(m.tag);
    if (digest === null) return { ok: false, reason: "model_server_or_model_unavailable" };
    if (digest !== m.digest) return { ok: false, reason: "digest_drift" };
    const id = upsertModelVersion(this.o.db, this.o.deps.newId, { tag: m.tag, digest, runtime: "ollama", runtimeVersion: await this.o.runtimeVersion(), parameters: { num_ctx: m.numCtx, temperature: m.temperature, seed: m.seed, num_predict: m.numPredict } });
    const peak = MEASURED_ADDITIONAL_PEAK_MIB[m.tag];
    if (peak !== undefined) {
      this.o.db
        .prepare("INSERT OR IGNORE INTO gpu_profiles(id, model_version_id, config_hash, measured_peak_mib, timings_json, validated_at) VALUES (?,?,?,?,?,?)")
        .run(this.o.deps.newId(), id, configHashOf({ numCtx: m.numCtx, numPredict: m.numPredict }), peak, JSON.stringify({ source: "TASK_023 nvidia-smi measurement of gemma4:12b at num_ctx 8192 (gemma4:12b entry in MEASURED_ADDITIONAL_PEAK_MIB)", note: "additional peak above the desktop baseline" }), this.o.deps.now().toISOString());
    }
    ensurePromptVersion(this.o.db, "analysis-v3", JSON.stringify(schemaVariant("analysis-v2")));
    this.modelVersionId = id;
    return { ok: true };
  }

  ownedModels(): string[] {
    return [this.cfg.analysis.tag];
  }
  profileKey() {
    return this.modelVersionId ? { modelVersionId: this.modelVersionId, configHash: configHashOf({ numCtx: this.cfg.analysis.numCtx, numPredict: this.cfg.analysis.numPredict }) } : null;
  }

  async run(ctx: RunnerContext<AnalysisPayload>): Promise<RunnerOutput> {
    const m = this.cfg.analysis;
    const installed = await this.o.installedDigest(m.tag);
    if (installed !== m.digest) throw new RunnerError("model_digest_mismatch", `installed digest of ${m.tag} differs from the pinned one: routing disabled, revalidate`, false);
    const input = this.loadContext(ctx.job.payload.attemptId);
    const allowed = new Set(input.allowedSkillIds);
    const result = await runStructured<AnalysisV2>({
      client: this.o.chat,
      model: m.tag,
      messages: [
        { role: "system", content: ANALYSIS_SYSTEM_V3 },
        { role: "user", content: buildAnalysisUserMessageV2(input) },
      ],
      format: schemaVariant("analysis-v2"),
      options: { num_ctx: m.numCtx, num_predict: m.numPredict, temperature: m.temperature, seed: m.seed },
      validate: (text) => validateAiOutput(text, "analysis-v2", { attemptId: input.attemptId, submittedText: input.submittedText, allowedSkillIds: allowed }),
      schemaValid: (text) => isSchemaValidOutput(text, "analysis-v2"),
      signal: ctx.signal,
      sleep: this.o.sleep,
    });
    if (!result.ok) {
      throw new RunnerError(result.code, result.issues.map((i) => `${i.code}: ${i.message}`).join("; ").slice(0, 400), result.code === "transport_failed");
    }
    const out = result.value;
    const usage = result.usage;
    const metrics = { calls: usage.calls, repaired: usage.repaired, transportRetries: usage.transportRetries, stats: usage.stats, rawOutputs: usage.rawOutputs, schemaValidBeforeRepair: usage.schemaValidBeforeRepair, semanticValidBeforeRepair: usage.validBeforeRepair };
    const modelVersionId = this.modelVersionId;
    const payload = ctx.job.payload;
    return {
      schemaVersion: "analysis-v2",
      output: out,
      metrics,
      alsoCommit: (db) => this.commitAnnotation(db, ctx.job, payload, out, { modelVersionId, metrics, text: input.submittedText }),
    };
  }

  /** Runs inside completeJob's transaction: annotation + (if the attempt is still waiting) a tentative model revision with findings. */
  private commitAnnotation(db: Db, job: Job, payload: AnalysisPayload, out: AnalysisV2, extra: { modelVersionId: string | null; metrics: unknown; text: string }): void {
    const jobResult = db.prepare("SELECT id FROM job_results WHERE job_id = ?").get(job.id) as { id: string };
    const attempt = db.prepare("SELECT id, slot_id, attempt_no, first_attempt, hints_before, answer_seen_before, idk, criterion_version FROM attempts WHERE id = ?").get(payload.attemptId) as AttemptRow | undefined;
    if (!attempt) throw new RunnerError("attempt_missing", "the analysed attempt no longer exists", false);
    const slot = loadSlotContext(db, attempt.slot_id);
    const latest = latestAssessment(db, attempt.id);
    const stillWaiting = latest !== undefined && latest.id === payload.assessmentId && latest.verdict === "pending";
    const annotationId = this.o.deps.newId();
    db.prepare("INSERT INTO ai_annotations(id, job_result_id, attempt_id, content_revision_id, status, findings_json, created_at) VALUES (?,?,?,?,?,?,?)").run(
      annotationId,
      jobResult.id,
      attempt.id,
      slot.exerciseRevisionId,
      "validated", // schema-valid draft: not "approved", not a linguistic judgement of record
      JSON.stringify({ output: out, provenance: { model: this.cfg.analysis.tag, digest: this.cfg.analysis.digest, modelVersionId: extra.modelVersionId, prompt: "analysis-v3", offsets: "unicode_code_points" }, superseded: !stillWaiting, usage: extra.metrics }),
      this.o.deps.now().toISOString(),
    );
    if (!stillWaiting || out.judgement === "abstain") return; // a human/other revision came first, or the model declined: keep the draft, change nothing

    const verdict = out.judgement === "acceptable" ? "correct" : out.judgement === "incorrect_candidate" ? "incorrect" : "ambiguous";
    const confirmation: Confirmation = out.judgement === "ambiguous" ? "uncertain" : "tentative";
    const decision: AssessmentDecision = {
      verdict,
      confirmation,
      source: "model",
      rationale: `AI draft (${this.cfg.analysis.tag}): ${out.explanation_ru}`.slice(0, 1000),
      modelVersionId: extra.modelVersionId ?? undefined,
      aiAnnotationId: annotationId,
      findings: out.findings.map((f) => ({
        skillId: f.skill_id,
        fragmentStart: f.start,
        fragmentEnd: f.end,
        correction: f.suggestion,
        explanationRu: f.explanation_ru,
        findingType: f.kind,
        verdict: f.confidence >= 0.5 ? ("tentative" as const) : ("uncertain" as const),
        confidence: f.confidence,
        modelVersionId: extra.modelVersionId ?? undefined,
      })),
    };
    writeAssessmentRevision(db, { ...this.o.deps, assessor: undefined as never, outbox: undefined as never } as AttemptDeps, slot as never, attempt, decision, latest);
  }

  // ------------------------------------------------------------------------------------------------------ input

  private loadContext(attemptId: string): AnalysisContext {
    const db = this.o.db;
    const a = db.prepare("SELECT id, slot_id, raw_answer_json AS raw, transcript_id AS tid FROM attempts WHERE id = ?").get(attemptId) as { id: string; slot_id: string; raw: string; tid: string | null } | undefined;
    if (!a) throw new RunnerError("attempt_missing", "unknown attempt", false);
    const raw = JSON.parse(a.raw) as { kind: string; text?: string };
    if (raw.kind !== "text" || typeof raw.text !== "string") throw new RunnerError("answer_not_text", "only written answers are analysed", false);
    const slot = loadSlotContext(db, a.slot_id);
    const c = JSON.parse(slot.contentJson) as { id: string; prompt_en: string; additional_skills: string[]; payload: { rubric?: { meaning_ru: string; target_markers: string[]; acceptable_variation_ru: string; reject_conditions_ru: string }; cue_ru?: string } };
    const rubric = c.payload.rubric;
    if (!rubric) throw new RunnerError("no_rubric", "the exercise has no rubric to analyse against", false);
    const hash = (db.prepare("SELECT content_hash AS h FROM exercise_revisions WHERE id = ?").get(slot.exerciseRevisionId) as { h: string }).h;
    const skills = (db.prepare("SELECT skill_id FROM skill_revisions WHERE taxonomy_id = ? AND active = 1 ORDER BY skill_id").all(slot.taxonomyId) as Array<{ skill_id: string }>).map((r) => r.skill_id);
    const edited = a.tid ? (db.prepare("SELECT edited FROM transcripts WHERE id = ?").get(a.tid) as { edited: number }).edited === 1 : false;
    return {
      attemptId,
      exerciseRevisionId: slot.exerciseRevisionId,
      contentHash: hash,
      prompt: c.prompt_en,
      meaning: rubric.meaning_ru,
      rubric: { target_markers: rubric.target_markers, acceptable_variation_ru: rubric.acceptable_variation_ru, reject_conditions_ru: rubric.reject_conditions_ru },
      submittedText: raw.text,
      targetSkill: resolveTargetSkillKey(slot),
      additionalSkills: c.additional_skills,
      transcriptEdited: edited,
      allowedSkillIds: skills,
    };
  }
}

export { randomUUID, sha, OllamaClient, TransportError };
