import { createHash } from "node:crypto";
import type { ExerciseType, ValidationIssue } from "@english-lab/contracts";
import type { Db } from "../../../db/open.js";
import { ApiError } from "../../../errors.js";
import { RunnerError, type JobRunner, type RunnerContext, type RunnerOutput } from "../../../queue/types.js";
import { upsertModelVersion } from "../../attempts/transcripts.js";
import type { ChatClient } from "../../ai/clients.js";
import { AI_CONFIG_V2, MEASURED_ADDITIONAL_PEAK_MIB, configHashOf } from "../../ai/config.js";
import { ensurePromptVersion } from "../../ai/prompts.js";
import { runStructured } from "../../ai/structured.js";
import type { Validated } from "../../ai/validate.js";
import { enqueue } from "../../../queue/jobs.js";
import { SCREEN_PROMPT } from "./advisoryRunner.js";
import { registerRevision, submitForReview, taxonomyForNewRevisions } from "../repository.js";
import { validateExercise } from "../validator.js";
import { GENERATION_PROMPT } from "./repository.js";
import { GENERATION_SYSTEM_V3, GENERATION_SYSTEM_V4, GENERATION_SYSTEM_V5, assembleExercise, buildGenerationUser, buildGenerationUserV4, draftFormat, draftFormatsText, type Built } from "./draftFormats.js";
import type { ItemPlan } from "./plan.js";
import { VOCABULARY_SYSTEM, VOCABULARY_SYSTEM_V2, assembleVocabulary, vocabularyFormat } from "./vocabularyDrafts.js";

export interface GenerationPayload {
  batchId: string;
  ordinals: number[];
}

export interface GenerationRunnerOptions {
  db: Db;
  chat: ChatClient;
  installedDigest: (tag: string) => Promise<string | null>;
  runtimeVersion: () => Promise<string>;
  deps: { now: () => Date; newId: () => string };
  sleep?: (ms: number) => Promise<void>;
}

/** Generation uses the pinned Qwen with a livelier temperature (spec/06: .6) and a 2048-token output cap. */
export const GENERATION_PARAMS = { numCtx: 4096, temperature: 0.6, seed: 42, numPredict: 2048 } as const;

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Stable UUID per (batch, ordinal): a re-delivered unit reproduces the same exercise id instead of inventing a second exercise. */
export function exerciseIdFor(batchId: string, ordinal: number): string {
  const h = sha(`exercise:${batchId}:${ordinal}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

interface QueuedItem {
  id: string;
  ordinal: number;
  plan: ItemPlan;
}

/**
 * Draft generation as short checkpointed units (<=4 items) through the single GPU dispatcher. The model proposes; the server builds,
 * validates, de-duplicates and stores. A stored draft is `draft -> validated (code) -> pending_review (code)`, never approved. Items
 * and the job result commit in ONE transaction, so a crash or duplicate delivery can neither lose nor repeat an ordinal.
 */
export class GenerationJobRunner implements JobRunner<GenerationPayload> {
  readonly kind = "generation" as const;
  private modelVersionId: string | null = null;

  constructor(private readonly o: GenerationRunnerOptions) {}

  private get pinned() {
    return AI_CONFIG_V2.analysis;
  }

  async prepare(): Promise<{ ok: boolean; reason?: string }> {
    const m = this.pinned;
    const digest = await this.o.installedDigest(m.tag);
    if (digest === null) return { ok: false, reason: "model_server_or_model_unavailable" };
    if (digest !== m.digest) return { ok: false, reason: "digest_drift" };
    const id = upsertModelVersion(this.o.db, this.o.deps.newId, { tag: m.tag, digest, runtime: "ollama", runtimeVersion: await this.o.runtimeVersion(), parameters: { num_ctx: GENERATION_PARAMS.numCtx, temperature: GENERATION_PARAMS.temperature, seed: GENERATION_PARAMS.seed, num_predict: GENERATION_PARAMS.numPredict } });
    const peak = MEASURED_ADDITIONAL_PEAK_MIB[m.tag];
    if (peak !== undefined) {
      this.o.db
        .prepare("INSERT OR IGNORE INTO gpu_profiles(id, model_version_id, config_hash, measured_peak_mib, timings_json, validated_at) VALUES (?,?,?,?,?,?)")
        .run(this.o.deps.newId(), id, configHashOf(GENERATION_PARAMS), peak, JSON.stringify({ source: "TASK_002/TASK_008 real measurements (ctx 4096)", note: "additional peak above the desktop baseline" }), this.o.deps.now().toISOString());
    }
    ensurePromptVersion(this.o.db, GENERATION_PROMPT, draftFormatsText());
    this.modelVersionId = id;
    return { ok: true };
  }

  ownedModels(): string[] {
    return [this.pinned.tag];
  }
  profileKey() {
    return this.modelVersionId ? { modelVersionId: this.modelVersionId, configHash: configHashOf(GENERATION_PARAMS) } : null;
  }

  private queued(payload: GenerationPayload): QueuedItem[] {
    const rows = this.o.db.prepare(`SELECT id, ordinal, plan_json FROM batch_items WHERE batch_id = ? AND state = 'queued' AND NOT EXISTS (SELECT 1 FROM batch_completions bc WHERE bc.batch_id = batch_items.batch_id) AND ordinal IN (${payload.ordinals.map(() => "?").join(",")}) ORDER BY ordinal`).all(payload.batchId, ...payload.ordinals) as Array<{ id: string; ordinal: number; plan_json: string }>;
    return rows.map((r) => ({ id: r.id, ordinal: r.ordinal, plan: JSON.parse(r.plan_json) as ItemPlan }));
  }

  async run(ctx: RunnerContext<GenerationPayload>): Promise<RunnerOutput> {
    const m = this.pinned;
    const payload = ctx.job.payload;
    const items = this.queued(payload);
    if (items.length === 0) {
      // duplicate delivery or a unit that already settled: nothing to ask the model, nothing to write
      return { schemaVersion: "generation-v1", output: { batchId: payload.batchId, ordinals: payload.ordinals, skipped: "already_settled" }, metrics: { calls: 0 } };
    }
    const installed = await this.o.installedDigest(m.tag);
    if (installed !== m.digest) throw new RunnerError("model_digest_mismatch", `installed digest of ${m.tag} differs from the pinned one`, false);

    const skills = taxonomyForNewRevisions(this.o.db).skills;
    const version = (this.o.db.prepare("SELECT prompt_version_id AS v FROM batches WHERE id = ?").get(payload.batchId) as { v: string } | undefined)?.v;
    const vocabulary = version === "vocabulary-generation-v1" || version === "vocabulary-generation-v2";
    const targetedRetry = version === "generation-v5" || version === "vocabulary-generation-v2";
    if (version !== "generation-v3" && version !== "generation-v4" && version !== "generation-v5" && !vocabulary) throw new RunnerError("unsupported_prompt_version", "This batch uses an unavailable historical generation prompt.", false);
    const first = items[0]!.plan;
    const model = { tag: m.tag, digest: m.digest };
    const user = vocabulary ? JSON.stringify({ batch_id: payload.batchId, items: items.map(i => i.plan), count: items.length }) : (version === "generation-v4" || version === "generation-v5" ? buildGenerationUserV4 : buildGenerationUser)(payload.batchId, items.map((i) => i.plan));
    const system = vocabulary ? (version === "vocabulary-generation-v2" ? VOCABULARY_SYSTEM_V2 : VOCABULARY_SYSTEM) : version === "generation-v5" ? GENERATION_SYSTEM_V5 : version === "generation-v4" ? GENERATION_SYSTEM_V4 : GENERATION_SYSTEM_V3;
    const build = (raw: unknown, item: QueuedItem): Built => vocabulary ? assembleVocabulary(raw, item.plan, exerciseIdFor(payload.batchId, item.ordinal), model, skills, version) : assembleExercise(raw, item.plan, { exerciseId: exerciseIdFor(payload.batchId, item.ordinal), model, promptVersion: version!, taxonomySkillIds: skills });

    const parse = (text: string): { ok: true; list: unknown[] } | { ok: false; issues: ValidationIssue[] } => {
      let v: unknown;
      try {
        v = JSON.parse(text);
      } catch {
        return { ok: false, issues: [{ code: "NOT_JSON", path: "", message: "the output is not one JSON document" }] };
      }
      const list = (v as { drafts?: unknown })?.drafts;
      if (typeof v !== "object" || v === null || Array.isArray(v) || !Array.isArray(list)) return { ok: false, issues: [{ code: "NO_DRAFTS", path: "", message: 'expected {"drafts":[...]}' }] };
      if (list.length === 0 || list.length > items.length) return { ok: false, issues: [{ code: "COUNT", path: "/drafts", message: `expected 1..${items.length} drafts, got ${list.length}` }] };
      return { ok: true, list };
    };
    const validate = (text: string): Validated<unknown[]> => {
      const p = parse(text);
      if (!p.ok) return { ok: false, value: null, issues: p.issues.map((x) => ({ code: x.code, message: x.message })) };
      const issues: ValidationIssue[] = [];
      p.list.forEach((raw, i) => {
        const b = build(raw, items[i]!);
        if (!b.ok) issues.push(...b.issues.map((x) => ({ ...x, path: `/drafts/${i}${x.path}` })));
      });
      return issues.length === 0 ? { ok: true, value: p.list, issues: [] } : { ok: false, value: null, issues: issues.map((x) => ({ code: x.code, message: `${x.path}: ${x.message}` })) };
    };

    const result = await runStructured<unknown[]>({
      client: this.o.chat,
      model: m.tag,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      format: vocabulary ? vocabularyFormat(items.length) : draftFormat(first.type as ExerciseType, items.length),
      options: { num_ctx: GENERATION_PARAMS.numCtx, num_predict: GENERATION_PARAMS.numPredict, temperature: GENERATION_PARAMS.temperature, seed: GENERATION_PARAMS.seed },
      validate,
      signal: ctx.signal,
      sleep: this.o.sleep,
    });
    if (!result.ok && result.code === "transport_failed") {
      throw new RunnerError("transport_failed", result.issues.map((i) => `${i.code}: ${i.message}`).join("; ").slice(0, 300), true);
    }
    ctx.checkpoint({ unit: payload.ordinals, modelCalled: true });

    // After the single repair attempt, valid items are kept and the others are quarantined one by one.
    const rawText = result.ok ? (result.usage.rawOutputs.at(-1) ?? "") : (result.usage.rawOutputs.at(-1) ?? "");
    const parsed = parse(rawText);
    // A shorter array cannot identify which requested ordinal was omitted. Quarantine the whole unit.
    const ambiguousCount = (version === "generation-v4" || version === "generation-v5" || vocabulary) && parsed.ok && parsed.list.length !== items.length;
    const proposals: Array<{ item: QueuedItem; built: Built; proposal?: unknown }> = items.map((item, i) => ({
      item,
      proposal: parsed.ok && !ambiguousCount ? parsed.list[i] : undefined,
      built: parsed.ok && !ambiguousCount && i < parsed.list.length ? build(parsed.list[i], item) : { ok: false, issues: [{ code: parsed.ok ? "MISSING_OUTPUT" : parsed.issues[0]!.code, path: "", message: parsed.ok ? "the model returned fewer exercises than requested; ordinal mapping is ambiguous" : parsed.issues[0]!.message }] },
    }));
    // Retry only failed ordinals individually. A short unit response cannot be mapped safely;
    // single-item requests recover it without guessing or overwriting valid siblings.
    let individualCalls = 0;
    if (targetedRetry) for (const candidate of proposals) {
      if (candidate.built.ok) continue;
      const item = candidate.item;
      const retryUser = vocabulary ? JSON.stringify({ batch_id: payload.batchId, items: [item.plan], count: 1 }) : buildGenerationUserV4(payload.batchId, [item.plan]);
      const failure = candidate.built.issues.map(i => `${i.code}: ${i.message}`).join("; ");
      const retry = await runStructured<unknown>({
        client: this.o.chat, model: m.tag,
        messages: [{ role: "system", content: system }, { role: "user", content: retryUser }, { role: "user", content: `Previous validation failed: ${failure}. Generate one corrected draft for this item.` }],
        format: vocabulary ? vocabularyFormat(1) : draftFormat(item.plan.type as ExerciseType, 1),
        options: { num_ctx: GENERATION_PARAMS.numCtx, num_predict: GENERATION_PARAMS.numPredict, temperature: GENERATION_PARAMS.temperature, seed: GENERATION_PARAMS.seed },
        validate: text => {
          try {
            const drafts = (JSON.parse(text) as { drafts?: unknown }).drafts;
            if (!Array.isArray(drafts) || drafts.length !== 1) return { ok: false, value: null, issues: [{ code: "COUNT", message: "Return exactly one draft." }] };
            const built = build(drafts[0], item);
            return built.ok ? { ok: true, value: drafts[0], issues: [] } : { ok: false, value: null, issues: built.issues.map(i => ({ code: i.code, message: i.message })) };
          } catch { return { ok: false, value: null, issues: [{ code: "NOT_JSON", message: "Return JSON only." }] }; }
        }, signal: ctx.signal, sleep: this.o.sleep,
      });
      individualCalls += retry.usage.calls;
      if (retry.ok) { candidate.proposal = retry.value; candidate.built = build(retry.value, item); }
    }
    const modelVersionId = this.modelVersionId;
    const usage = { calls: result.usage.calls + individualCalls, individualCalls, repaired: result.usage.repaired, transportRetries: result.usage.transportRetries };
    return {
      schemaVersion: "generation-v1",
      output: { batchId: payload.batchId, ordinals: payload.ordinals, proposed: parsed.ok ? parsed.list.length : 0, outputHash: sha(rawText), valid: proposals.filter((p) => p.built.ok).length },
      metrics: { ...usage, stats: result.usage.stats },
      alsoCommit: (db) => this.commit(db, payload, proposals, { tag: m.tag, digest: m.digest, modelVersionId }),
    };
  }

  private clustersFor(items: QueuedItem[]): string[] {
    const skills = [...new Set(items.map((i) => i.plan.target_skill))];
    const out = new Set<string>();
    for (const s of skills) {
      const rows = this.o.db
        .prepare(`SELECT DISTINCT er.template_cluster AS c FROM exercise_revisions er JOIN exercise_skills es ON es.revision_id = er.id AND es.role = 'target' JOIN skill_revisions sr ON sr.id = es.skill_revision_id WHERE sr.skill_id = ? ORDER BY er.created_at DESC LIMIT 20`)
        .all(s) as Array<{ c: string }>;
      for (const r of rows) out.add(r.c);
    }
    return [...out].slice(0, 20);
  }

  /** Runs inside completeJob's transaction. Each item is its own savepoint: one bad draft never rolls back its siblings. */
  private commit(db: Db, payload: GenerationPayload, proposals: Array<{ item: QueuedItem; built: Built; proposal?: unknown }>, model: { tag: string; digest: string; modelVersionId: string | null }): void {
    if (db.prepare("SELECT 1 FROM batch_completions WHERE batch_id = ?").get(payload.batchId)) return;
    const deps = this.o.deps;
    const now = deps.now().toISOString();
    const settle = db.prepare("UPDATE batch_items SET state = ?, revision_id = ?, error_json = ?, updated_at = ? WHERE id = ? AND state = 'queued'");
    const actor = { type: "model" as const, id: `${model.tag}@${model.digest.slice(0, 12)}` };
    for (const { item, built, proposal } of proposals) {
      const still = db.prepare("SELECT state FROM batch_items WHERE id = ?").get(item.id) as { state: string } | undefined;
      if (still?.state !== "queued") continue; // settled by another delivery
      if (!built.ok) {
        settle.run("invalid", null, JSON.stringify({ stage: "validation", issues: built.issues, proposal }), now, item.id);
        continue;
      }
      try {
        db.transaction(() => {
          const reg = registerRevision(db, deps, { content: built.exercise, actor, reason: `generated by ${GENERATION_PROMPT} (batch ${payload.batchId}, item ${item.ordinal})`, sourceBatchId: payload.batchId });
          if (reg.replayed) throw new ApiError(409, "DUPLICATE_REVISION", "identical content is already stored", { revisionId: reg.revisionId });
          submitForReview(db, deps, reg.revisionId, { type: "code", id: "batch-generator" }, "validated draft queued for individual review");
          // a cheap second pair of eyes for the human reviewer (D49): advisory only, not tied to the batch so it never blocks "generation done"
          enqueue(db, deps, { kind: "triage", payload: { revisionId: reg.revisionId }, idempotencyKey: `advisory:${reg.revisionId}:${SCREEN_PROMPT}`, priority: 3 });
          settle.run("generated", reg.revisionId, reg.warnings.length > 0 ? JSON.stringify({ warnings: reg.warnings.map((w) => ({ code: w.code, message: w.message })) }) : null, now, item.id);
        })();
      } catch (e) {
        const err = e as ApiError & { details?: { errors?: unknown } };
        settle.run("invalid", null, JSON.stringify({ stage: "registration", code: err.code ?? "ERROR", message: err.message, details: err.details ?? null, proposal: built.exercise }), now, item.id);
      }
    }
    // an item the model never answered stays accounted for: it is quarantined, not silently dropped
    for (const it of this.queued(payload)) {
      settle.run("invalid", null, JSON.stringify({ stage: "validation", issues: [{ code: "MISSING_OUTPUT", path: "", message: "no draft was produced for this ordinal" }] }), now, it.id);
    }
  }
}
