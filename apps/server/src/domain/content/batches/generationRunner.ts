import { createHash } from "node:crypto";
import type { ExerciseType, ValidationIssue } from "@english-lab/contracts";
import type { Db } from "../../../db/open.js";
import { ApiError } from "../../../errors.js";
import { RunnerError, type JobRunner, type RunnerContext, type RunnerOutput } from "../../../queue/types.js";
import { upsertModelVersion } from "../../attempts/transcripts.js";
import type { ChatClient } from "../../ai/clients.js";
import { AI_CONFIG_V3, RESIDENT_NUM_CTX, MEASURED_ADDITIONAL_PEAK_MIB, configHashOf } from "../../ai/config.js";
import { ensurePromptVersion } from "../../ai/prompts.js";
import { runStructured } from "../../ai/structured.js";
import type { Validated } from "../../ai/validate.js";
import { enqueue } from "../../../queue/jobs.js";
import { SCREEN_PROMPT } from "./advisoryRunner.js";
import { checkDuplicates, registerRevision, submitForReview, taxonomyForNewRevisions } from "../repository.js";
import { validateExercise } from "../validator.js";
import { GENERATION_PROMPT } from "./repository.js";
import { GENERATION_SYSTEM_V3, GENERATION_SYSTEM_V4, GENERATION_SYSTEM_V5, GENERATION_SYSTEM_V6, GENERATION_SYSTEM_V7, GENERATION_SYSTEM_V8, GENERATION_SYSTEM_V9, assembleExercise, buildGenerationUser, buildGenerationUserV4, draftFormat, draftFormatsText, type Built } from "./draftFormats.js";
import type { ItemPlan } from "./plan.js";
import { articleMismatch } from "./languageChecks.js";
import { VOCABULARY_SYSTEM, VOCABULARY_SYSTEM_V2, VOCABULARY_SYSTEM_V3, VOCABULARY_SYSTEM_V4, VOCABULARY_SYSTEM_V5, VOCABULARY_SYSTEM_V6, VOCABULARY_SYSTEM_V7, VOCABULARY_SYSTEM_V8, assembleVocabulary, vocabularyFormat } from "./vocabularyDrafts.js";
import { itContext } from "./itContext.js";
import { pickVocabularyTopic } from "./vocabularyTopics.js";
import type { LexiconHint } from "../../vocabulary/lexiconHint.js";
import { dictationFormat } from "../../typing/dictation/prompt.js";
import { runDictationJob, type DictationJobPayload as DictationPayload } from "../../typing/dictation/runner.js";
import type { DictationEnv } from "../../typing/dictation/lessons.js";
import { expressionsForForms } from "../../vocabulary/expressions.js";
import { matchForms } from "../../vocabulary/forms.js";
import { EXPRESSION_PROMPT, expressionFormat, EXPRESSION_SYSTEM_V1, validateExpressionOutput, type ExpressionDraft } from "../../vocabulary/expressions.js";
import { THOUGHT_SYSTEM_V1, thoughtFormat, validateInterpretation, type Interpretation } from "../../thoughts/interpret.js";

export interface GenerationPayload {
  batchId: string;
  ordinals: number[];
}
/** TASK_026: reading one saved Russian thought (no batch yet); runs through the same dispatcher and model as draft generation */
export interface ThoughtPayload {
  thoughtId: string;
}

export type { DictationPayload };
/** one saved expression: the model writes a draft (translation, an example, a description) */
export interface ExpressionPayload {
  expressionId: string;
  attempt: number;
}

export interface GenerationRunnerOptions {
  db: Db;
  chat: ChatClient;
  installedDigest: (tag: string) => Promise<string | null>;
  runtimeVersion: () => Promise<string>;
  deps: { now: () => Date; newId: () => string };
  sleep?: (ms: number) => Promise<void>;
  /** Opt-in for controlled tests; the running application leaves Nimble disabled. */
  advisoryEnabled?: boolean;
  /** Audio Dictation (TASK_028): one sentence per job; absent = such jobs fail as unavailable */
  dictation?: DictationEnv;
  /** the learner's 20k word list (a local CSV): lookalike wrong options for vocabulary v8; absent = none */
  lexicon?: { all(): Promise<ReadonlyMap<string, LexiconHint>> };
}

/** Generation uses the pinned Qwen with a livelier temperature (spec/06: .6) and a 2048-token output cap. */
export const GENERATION_PARAMS = { numCtx: RESIDENT_NUM_CTX, temperature: 0.6, seed: 42, numPredict: 2048 } as const;

const OPTION_CHECK_SYSTEM = `You check one multiple-choice vocabulary item for a learner of Australian English. The sentence has a gap ___. The key is the intended answer. Decide for EVERY wrong option separately: if it is put into the gap (in the form shown, with the words around the gap), is the sentence grammatical and sensible enough that a fair teacher would have to accept it? "fits" is true when it works grammatically and could mean something reasonable here, even if it is less natural than the key. "fits" is false when it is ungrammatical (wrong form, missing particle or article, impossible with the next word) or its meaning clearly contradicts the context. Return JSON only: {"options":[{"id":"b","fits":false}]} listing every wrong option.`;
const RIVALS_SYSTEM = `You check a fill-in-the-gap item for a learner of English. The sentence has one gap ___ and the intended answer is given. List up to 5 OTHER English words or phrases (not forms of the answer) that a fluent speaker would also accept in the gap with the same overall meaning. Return JSON only: {"alternatives":[...]}; an empty list when nothing else fits well.`;
/** vocabulary v7: lower than the shared .6 so options and Russian stay accurate; variety comes from the topic and the scene hints */
const VOCABULARY_TEMPERATURE = 0.4;
/** single-item retries for a failed draft, after the unit-level repair */
const RETRY_ATTEMPTS = 3;
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
export class GenerationJobRunner implements JobRunner<GenerationPayload | ThoughtPayload | DictationPayload | ExpressionPayload> {
  readonly kind = "generation" as const;
  private modelVersionId: string | null = null;

  constructor(private readonly o: GenerationRunnerOptions) {}

  private get pinned() {
    return AI_CONFIG_V3.analysis;
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
        .run(this.o.deps.newId(), id, configHashOf(GENERATION_PARAMS), peak, JSON.stringify({ source: "TASK_023 nvidia-smi measurement of gemma4:12b at num_ctx 8192 (gemma4:12b entry in MEASURED_ADDITIONAL_PEAK_MIB) (ctx 8192)", note: "additional peak above the desktop baseline" }), this.o.deps.now().toISOString());
    }
    ensurePromptVersion(this.o.db, GENERATION_PROMPT, draftFormatsText(GENERATION_PROMPT));
    ensurePromptVersion(this.o.db, "thought-interpret-v1", JSON.stringify(thoughtFormat()));
    ensurePromptVersion(this.o.db, "dictation-v3", JSON.stringify(dictationFormat()));
    ensurePromptVersion(this.o.db, EXPRESSION_PROMPT, JSON.stringify(expressionFormat()));
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

  /** One saved thought -> an English reading and reusable patterns (a new append-only thought_analyses row). Nothing is published. */
  private async runThought(ctx: RunnerContext<ThoughtPayload>): Promise<RunnerOutput> {
    const m = this.pinned;
    const { thoughtId } = ctx.job.payload;
    const row = this.o.db.prepare("SELECT t.text_ru AS text, (SELECT status FROM thought_analyses WHERE thought_id = t.id ORDER BY created_at DESC, rowid DESC LIMIT 1) AS status FROM personal_thoughts t WHERE t.id = ?").get(thoughtId) as { text: string; status: string | null } | undefined;
    if (!row || row.status !== "pending") return { schemaVersion: "thought-v1", output: { thoughtId, skipped: "already_settled" }, metrics: { calls: 0 } };
    const installed = await this.o.installedDigest(m.tag);
    if (installed !== m.digest) throw new RunnerError("model_digest_mismatch", `installed digest of ${m.tag} differs from the pinned one`, false);
    const result = await runStructured<Interpretation>({
      client: this.o.chat,
      model: m.tag,
      messages: [
        { role: "system", content: THOUGHT_SYSTEM_V1 },
        { role: "user", content: JSON.stringify({ thought_ru: row.text }) },
      ],
      format: thoughtFormat(),
      options: { num_ctx: GENERATION_PARAMS.numCtx, num_predict: 1024, temperature: 0.3, seed: GENERATION_PARAMS.seed },
      validate: (text) => validateInterpretation(text),
      signal: ctx.signal,
      sleep: this.o.sleep,
    });
    if (!result.ok && result.code === "transport_failed") throw new RunnerError("transport_failed", result.issues.map((i) => `${i.code}: ${i.message}`).join("; ").slice(0, 300), true);
    ctx.checkpoint({ thoughtId, modelCalled: true });
    // the model only proposes the English and the patterns; an agent chooses the skills before anything is drafted
    const status = result.ok ? (result.value.status === "ok" ? "needs_skills" : result.value.status) : "failed";
    const output = result.ok ? result.value : { issues: result.issues.map((i) => ({ code: i.code, message: i.message })) };
    const { now, newId } = this.o.deps;
    return {
      schemaVersion: "thought-v1",
      output: { thoughtId, status },
      metrics: { calls: result.usage.calls, repaired: result.usage.repaired },
      alsoCommit: (db) => {
        const latest = db.prepare("SELECT status FROM thought_analyses WHERE thought_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(thoughtId) as { status: string } | undefined;
        if (latest?.status !== "pending") return; // settled by another delivery
        db.prepare("INSERT INTO thought_analyses(id, thought_id, status, output_json, created_at) VALUES (?,?,?,?,?)").run(newId(), thoughtId, status, JSON.stringify({ ...output, model: `${m.tag}@${m.digest.slice(0, 12)}`, prompt: "thought-interpret-v1" }), now().toISOString());
      },
    };
  }

  /** TASK_028: one sentence of an Audio Dictation lesson (Gemma, code checks, Piper, Whisper check) */
  private async runDictation(ctx: RunnerContext<DictationPayload>): Promise<RunnerOutput> {
    const env = this.o.dictation;
    if (!env) throw new RunnerError("tts_not_installed", "Audio Dictation is not configured", false);
    const m = this.pinned;
    return runDictationJob(ctx, {
      db: this.o.db,
      chat: this.o.chat,
      model: { tag: m.tag, digest: m.digest },
      params: { numCtx: GENERATION_PARAMS.numCtx, temperature: GENERATION_PARAMS.temperature, seed: GENERATION_PARAMS.seed },
      env,
      deps: this.o.deps,
      sleep: this.o.sleep,
      assertModel: async () => {
        const installed = await this.o.installedDigest(m.tag);
        if (installed !== m.digest) throw new RunnerError("model_digest_mismatch", `installed digest of ${m.tag} differs from the pinned one`, false);
      },
    });
  }

  /** one saved expression -> a draft revision (never overwrites the learner's own text: it is a new, older-than-user revision only when none exists) */
  private async runExpression(ctx: RunnerContext<ExpressionPayload>): Promise<RunnerOutput> {
    const m = this.pinned;
    const { expressionId } = ctx.job.payload;
    const e = this.o.db.prepare("SELECT phrase FROM vocabulary_expressions x WHERE x.id = ? AND (SELECT kind FROM vocabulary_expression_events ev WHERE ev.expression_id = x.id ORDER BY ev.created_at DESC, ev.rowid DESC LIMIT 1) IS NOT 'removed'").get(expressionId) as { phrase: string } | undefined;
    const done = e ? this.o.db.prepare("SELECT 1 FROM vocabulary_expression_revisions WHERE expression_id = ?").get(expressionId) : undefined;
    if (!e || done) return { schemaVersion: "expression-v1", output: { expressionId, skipped: e ? "already_written" : "removed" }, metrics: { calls: 0 } };
    const installed = await this.o.installedDigest(m.tag);
    if (installed !== m.digest) throw new RunnerError("model_digest_mismatch", `installed digest of ${m.tag} differs from the pinned one`, false);
    const result = await runStructured<ExpressionDraft>({
      client: this.o.chat,
      model: m.tag,
      messages: [
        { role: "system", content: EXPRESSION_SYSTEM_V1 },
        { role: "user", content: JSON.stringify({ expression: e.phrase }) },
      ],
      format: expressionFormat(),
      options: { num_ctx: GENERATION_PARAMS.numCtx, num_predict: 768, temperature: 0.3, seed: GENERATION_PARAMS.seed + ctx.job.retryCount },
      validate: (text) => validateExpressionOutput(text, e.phrase),
      signal: ctx.signal,
      sleep: this.o.sleep,
    });
    if (!result.ok) throw new RunnerError(result.code, result.issues.map((i) => `${i.code}: ${i.message}`).join("; ").slice(0, 300), true, result.issues.map((i) => i.code));
    const d = result.value;
    const { now, newId } = this.o.deps;
    return {
      schemaVersion: "expression-v1",
      output: { expressionId },
      metrics: { calls: result.usage.calls, repaired: result.usage.repaired },
      alsoCommit: (db) => {
        if (db.prepare("SELECT 1 FROM vocabulary_expression_revisions WHERE expression_id = ?").get(expressionId)) return; // the learner (or another delivery) was first
        const jr = db.prepare("SELECT id FROM job_results WHERE job_id = ?").get(ctx.job.id) as { id: string } | undefined;
        db.prepare("INSERT INTO vocabulary_expression_revisions(id, expression_id, revision, translation_ru, example_en, description_ru, source, status, job_result_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(newId(), expressionId, 1, d.translation_ru, d.example_en, d.description_ru, "model", "draft", jr?.id ?? null, now().toISOString());
      },
    };
  }

  async run(ctx: RunnerContext<GenerationPayload | ThoughtPayload | DictationPayload | ExpressionPayload>): Promise<RunnerOutput> {
    if ("expressionId" in ctx.job.payload) return this.runExpression(ctx as RunnerContext<ExpressionPayload>);
    if ("dictationLessonId" in ctx.job.payload || "dictationPool" in ctx.job.payload) return this.runDictation(ctx as RunnerContext<DictationPayload>);
    if ("thoughtId" in ctx.job.payload) return this.runThought(ctx as RunnerContext<ThoughtPayload>);
    ctx = ctx as RunnerContext<GenerationPayload>;
    const m = this.pinned;
    const payload = (ctx as RunnerContext<GenerationPayload>).job.payload;
    const items = this.queued(payload);
    if (items.length === 0) {
      // duplicate delivery or a unit that already settled: nothing to ask the model, nothing to write
      return { schemaVersion: "generation-v1", output: { batchId: payload.batchId, ordinals: payload.ordinals, skipped: "already_settled" }, metrics: { calls: 0 } };
    }
    const installed = await this.o.installedDigest(m.tag);
    if (installed !== m.digest) throw new RunnerError("model_digest_mismatch", `installed digest of ${m.tag} differs from the pinned one`, false);

    const skills = taxonomyForNewRevisions(this.o.db).skills;
    const version = (this.o.db.prepare("SELECT prompt_version_id AS v FROM batches WHERE id = ?").get(payload.batchId) as { v: string } | undefined)?.v;
    const vocabulary = version === "vocabulary-generation-v1" || version === "vocabulary-generation-v2" || version === "vocabulary-generation-v3" || version === "vocabulary-generation-v4" || version === "vocabulary-generation-v5" || version === "vocabulary-generation-v6" || version === "vocabulary-generation-v7" || version === "vocabulary-generation-v8";
    const targetedRetry = (version === "generation-v5" || version === "generation-v6" || version === "generation-v7" || version === "generation-v8" || (version === "generation-v9" || version === "generation-v10")) || version === "vocabulary-generation-v2" || version === "vocabulary-generation-v3" || version === "vocabulary-generation-v4" || version === "vocabulary-generation-v5" || version === "vocabulary-generation-v6" || version === "vocabulary-generation-v7" || version === "vocabulary-generation-v8";
    if (version !== "generation-v3" && version !== "generation-v4" && version !== "generation-v5" && version !== "generation-v6" && version !== "generation-v7" && version !== "generation-v8" && version !== "generation-v9" && version !== "generation-v10" && !vocabulary) throw new RunnerError("unsupported_prompt_version", "This batch uses an unavailable historical generation prompt.", false);
    const first = items[0]!.plan;
    const model = { tag: m.tag, digest: m.digest };
    const v4 = version === "vocabulary-generation-v4" || version === "vocabulary-generation-v5" || version === "vocabulary-generation-v6" || version === "vocabulary-generation-v7" || version === "vocabulary-generation-v8";
    const v8 = version === "vocabulary-generation-v8";
    const v7 = version === "vocabulary-generation-v7" || v8;
    const v5 = version === "vocabulary-generation-v5" || version === "vocabulary-generation-v6" || version === "vocabulary-generation-v7" || version === "vocabulary-generation-v8";
    const withAvoid = (plan: ItemPlan): ItemPlan => v4 ? { ...plan, avoid_sentences: this.avoidSentences(plan), ...(plan.topic === "technology" ? { it_context: itContext(plan.ordinal) } : {}), ...(v5 ? this.expressionHint(plan) : {}), ...(v7 ? this.meaningHint(plan) : {}) } as ItemPlan : plan;
    // v8: three topic suggestions instead of one fixed topic; the model may ignore them when the word does not suit any
    const ideas = (plan: ItemPlan): ItemPlan => {
      if (!v8) return plan;
      const { topic, it_context: _it, ...rest } = plan as ItemPlan & { it_context?: unknown };
      const first = topic === "technology" ? "software development or other IT work" : topic;
      return { ...rest, topic_ideas: [first, pickVocabularyTopic(plan.ordinal + 57, 1), pickVocabularyTopic(plan.ordinal + 113, 2)] } as unknown as ItemPlan;
    };
    const user = vocabulary ? JSON.stringify({ batch_id: payload.batchId, items: items.map(i => ideas(withAvoid(i.plan))), count: items.length }) : (version === "generation-v4" || version === "generation-v5" || version === "generation-v6" || version === "generation-v7" || version === "generation-v8" || (version === "generation-v9" || version === "generation-v10") ? (b: string, p: ItemPlan[]) => buildGenerationUserV4(b, p, version) : (b: string, p: ItemPlan[]) => buildGenerationUser(b, p, version))(payload.batchId, items.map((i) => i.plan));
    const system = vocabulary ? (version === "vocabulary-generation-v8" ? VOCABULARY_SYSTEM_V8 : version === "vocabulary-generation-v7" ? VOCABULARY_SYSTEM_V7 : version === "vocabulary-generation-v6" ? VOCABULARY_SYSTEM_V6 : version === "vocabulary-generation-v5" ? VOCABULARY_SYSTEM_V5 : version === "vocabulary-generation-v4" ? VOCABULARY_SYSTEM_V4 : version === "vocabulary-generation-v3" ? VOCABULARY_SYSTEM_V3 : version === "vocabulary-generation-v2" ? VOCABULARY_SYSTEM_V2 : VOCABULARY_SYSTEM) : (version === "generation-v9" || version === "generation-v10") ? GENERATION_SYSTEM_V9 : version === "generation-v8" ? GENERATION_SYSTEM_V8 : version === "generation-v7" ? GENERATION_SYSTEM_V7 : version === "generation-v6" ? GENERATION_SYSTEM_V6 : version === "generation-v5" ? GENERATION_SYSTEM_V5 : version === "generation-v4" ? GENERATION_SYSTEM_V4 : GENERATION_SYSTEM_V3;
    // A repeat of a sentence already in the bank is found here, in code, before any agent sees the draft: the targeted retry then writes a new one.
    // Exact repeats are errors; near repeats (trigram Jaccard >= .80) are treated the same way so the reviewer never spends tokens on them.
    const rejectRepeats = (built: Built, item: QueuedItem): Built => {
      if (!built.ok || !(v4 || targetedRetry)) return built;
      const v = validateExercise(built.exercise, { taxonomySkillIds: skills });
      if (!v.ok) return built;
      const c = built.exercise as { template_cluster: string; target_skill: string };
      const dups = checkDuplicates(this.o.db, { exerciseId: exerciseIdFor(payload.batchId, item.ordinal), templateCluster: c.template_cluster, targetSkill: c.target_skill, units: v.units });
      const near = dups.warnings.some(w => w.code === "NEAR_DUPLICATE" || w.code === "SAME_TEMPLATE_CLUSTER");
      return dups.errors.length > 0 || near ? { ok: false, issues: [{ code: "DUPLICATE_SENTENCE", path: "", message: "This sentence is already in the bank or is almost the same as one. Write a different sentence in a different situation, with different people, objects and wording." }] } : built;
    };
    // v7: the local model reads the wrong options once more; a draft with a wrong option that also fits is sent back like any other failed draft
    const fitIssue = async (built: Built, item: QueuedItem): Promise<Built> => {
      if (!v7 || !built.ok) return built;
      const recall = (built.exercise.vocabulary as { family?: string } | undefined)?.family === "guided_recall";
      if (recall) {
        if (!v8) return built;
        const e = built.exercise as { prompt_en: string; payload: { accepted_answers: string[] }; vocabulary: { target: { surfaceForm: string } } };
        const rivals = await this.recallRivals(e.prompt_en, e.vocabulary.target.surfaceForm, e.payload.accepted_answers, m.tag, ctx.signal);
        return rivals.length === 0 ? built : { ok: false, issues: [{ code: "ANSWER_NOT_UNIQUE", path: "", message: `"${rivals.join('", "')}" also fits the gap and the cue (same first letter and length). Change the sentence so only the target word fits.` }] };
      }
      const replaced = await this.replaceDistractors(built, item.plan, m.tag, ctx.signal, v8);
      if (replaced) return replaced;
      const bad = await this.optionsThatFit(built.exercise, m.tag, ctx.signal);
      if (bad.length === 0) return built;
      const texts = (built.exercise.payload as { options: Array<{ id: string; text: string }> }).options.filter((o) => bad.includes(o.id)).map((o) => `"${o.text}"`).join(", ");
      return { ok: false, issues: [{ code: "OPTION_ALSO_FITS", path: "", message: `The wrong option ${texts} also fits the gap. Add a clause that excludes it, or replace it with an option that is clearly wrong here (another word class or a different meaning).` }] };
    };
    const buildVocabulary = (raw: unknown, item: QueuedItem): Built => rejectRepeats(assembleVocabulary(raw, item.plan, exerciseIdFor(payload.batchId, item.ordinal), model, skills, version, this.synonymsFor(item.plan.vocabulary?.lemma)), item);
    const build = (raw: unknown, item: QueuedItem): Built => vocabulary ? buildVocabulary(raw, item) : rejectRepeats(assembleExercise(raw, item.plan, { exerciseId: exerciseIdFor(payload.batchId, item.ordinal), model, promptVersion: version!, taxonomySkillIds: skills }), item);

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
      format: vocabulary ? vocabularyFormat(items.length) : draftFormat(first.type as ExerciseType, items.length, version ?? "", first.variant),
      options: { num_ctx: GENERATION_PARAMS.numCtx, num_predict: GENERATION_PARAMS.numPredict, temperature: v7 ? VOCABULARY_TEMPERATURE : GENERATION_PARAMS.temperature, seed: GENERATION_PARAMS.seed },
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
    const ambiguousCount = (version === "generation-v4" || version === "generation-v5" || version === "generation-v6" || version === "generation-v7" || version === "generation-v8" || (version === "generation-v9" || version === "generation-v10") || vocabulary) && parsed.ok && parsed.list.length !== items.length;
    const proposals: Array<{ item: QueuedItem; built: Built; proposal?: unknown }> = items.map((item, i) => ({
      item,
      proposal: parsed.ok && !ambiguousCount ? parsed.list[i] : undefined,
      built: parsed.ok && !ambiguousCount && i < parsed.list.length ? build(parsed.list[i], item) : { ok: false, issues: [{ code: parsed.ok ? "MISSING_OUTPUT" : parsed.issues[0]!.code, path: "", message: parsed.ok ? "the model returned fewer exercises than requested; ordinal mapping is ambiguous" : parsed.issues[0]!.message }] },
    }));
    if (v7) for (const candidate of proposals) candidate.built = await fitIssue(candidate.built, candidate.item);
    // Retry only failed ordinals individually. A short unit response cannot be mapped safely;
    // single-item requests recover it without guessing or overwriting valid siblings.
    let individualCalls = 0;
    if (targetedRetry) for (const candidate of proposals) {
      if (candidate.built.ok) continue;
      const item = candidate.item;
      const retryUser = vocabulary ? JSON.stringify({ batch_id: payload.batchId, items: [ideas(withAvoid(item.plan))], count: 1 }) : buildGenerationUserV4(payload.batchId, [item.plan]);
      // up to RETRY_ATTEMPTS single-item attempts, each told why the previous one failed
      for (let attempt = 1; attempt <= RETRY_ATTEMPTS && !candidate.built.ok; attempt++) {
      const failure = candidate.built.issues.map(i => `${i.code}: ${i.message}`).join("; ");
      const retry = await runStructured<unknown>({
        client: this.o.chat, model: m.tag,
        messages: [{ role: "system", content: system }, { role: "user", content: retryUser }, { role: "user", content: `Previous validation failed: ${failure}. Generate one corrected draft for this item.` }],
        format: vocabulary ? vocabularyFormat(1) : draftFormat(item.plan.type as ExerciseType, 1, version ?? "", item.plan.variant),
        options: { num_ctx: GENERATION_PARAMS.numCtx, num_predict: GENERATION_PARAMS.numPredict, temperature: v7 ? VOCABULARY_TEMPERATURE : GENERATION_PARAMS.temperature, seed: GENERATION_PARAMS.seed + attempt + item.ordinal * 7 },
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
      if (retry.ok) { candidate.proposal = retry.value; candidate.built = await fitIssue(build(retry.value, item), item); }
      }
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

  /** synonyms the lexicon lists for a saved word (draft reference facts); empty when there are none */
  private synonymsFor(lemma: string | undefined): string[] {
    if (!lemma) return [];
    const rows = this.o.db.prepare("SELECT l.synonyms_json AS s FROM vocabulary_lexicon l JOIN vocabulary_entries e ON e.id = l.entry_id WHERE e.lemma = ? COLLATE NOCASE").all(lemma) as Array<{ s: string }>;
    return rows.flatMap(r => { try { return JSON.parse(r.s) as string[]; } catch { return []; } });
  }

  /**
   * Everything the program knows about one planned item, for an agent that writes the sentence itself: topic ideas, the word's meaning and synonyms,
   * sentences to avoid, an expression to weave in, and wrong-option candidates (studied words of the same part of speech, lookalikes from the 20k list).
   */
  async authoringContext(plan: ItemPlan): Promise<Record<string, unknown>> {
    const lemma = plan.vocabulary!.lemma;
    const pos = (this.o.db.prepare("SELECT (SELECT r.part_of_speech FROM vocabulary_revisions r WHERE r.entry_id = e.id ORDER BY r.revision DESC LIMIT 1) AS pos FROM vocabulary_entries e WHERE e.lemma = ? COLLATE NOCASE").get(lemma) as { pos: string | null } | undefined)?.pos ?? null;
    const first = plan.topic === "technology" ? "software development or other IT work" : plan.topic;
    return {
      topic_ideas: [first, pickVocabularyTopic(plan.ordinal + 57, 1), pickVocabularyTopic(plan.ordinal + 113, 2)],
      target_level: plan.level ?? "B2",
      ...this.meaningHint(plan),
      avoid_sentences: this.avoidSentences(plan),
      ...this.expressionHint(plan),
      distractor_candidates: {
        part_of_speech: pos,
        studied_words: this.distractorPool(lemma, plan.ordinal).slice(0, 6),
        lookalikes: pos && pos !== "unknown" ? await this.lookalikes(lemma, pos, plan.ordinal) : [],
      },
    };
  }

  /** synonyms the lexicon lists for a word: the program rejects them as wrong options */
  synonymsOf(lemma: string): string[] {
    return this.synonymsFor(lemma);
  }

  /** the sense to illustrate and the words that must not be wrong options (the lexicon's own facts about the saved word) */
  private meaningHint(plan: ItemPlan): { definition_ru?: string; synonyms_not_to_use_as_distractors?: string[] } {
    const lemma = plan.vocabulary?.lemma;
    if (!lemma) return {};
    const row = this.o.db.prepare("SELECT l.definition_ru AS d FROM vocabulary_lexicon l JOIN vocabulary_entries e ON e.id = l.entry_id WHERE e.lemma = ? COLLATE NOCASE ORDER BY l.created_at DESC, l.rowid DESC LIMIT 1").get(lemma) as { d: string } | undefined;
    const synonyms = this.synonymsFor(lemma);
    return { ...(row?.d ? { definition_ru: row.d } : {}), ...(synonyms.length ? { synonyms_not_to_use_as_distractors: synonyms } : {}) };
  }

  /** the local model's verdict for each wrong option: true = it also fits the gap. null when the call failed or the answer is unreadable. */
  private async fitVerdicts(sentence: string, key: string, wrong: Array<{ id: string; text: string }>, model: string, signal?: AbortSignal): Promise<Map<string, boolean> | null> {
    if (wrong.length === 0) return new Map();
    try {
      const r = await this.o.chat.chat({
        model,
        messages: [
          { role: "system", content: OPTION_CHECK_SYSTEM },
          { role: "user", content: JSON.stringify({ sentence, key, wrong_options: wrong }) },
        ],
        format: { type: "object", required: ["options"], properties: { options: { type: "array", items: { type: "object", required: ["id", "fits"], properties: { id: { type: "string" }, fits: { type: "boolean" } } } } } },
        options: { num_ctx: GENERATION_PARAMS.numCtx, num_predict: 40 + 30 * wrong.length, temperature: 0, seed: GENERATION_PARAMS.seed },
        signal,
      });
      const parsed = JSON.parse(r.text) as { options?: Array<{ id?: string; fits?: boolean }> };
      const ids = new Set(wrong.map((o) => o.id));
      const out = new Map<string, boolean>();
      for (const o of parsed.options ?? []) if (typeof o.id === "string" && ids.has(o.id) && typeof o.fits === "boolean") out.set(o.id, o.fits);
      return out;
    } catch (e) {
      if (signal?.aborted || (e as Error).name === "AbortError") throw e;
      return null;
    }
  }

  /**
   * Local-model check of the wrong options of one multiple-choice draft: the ids of the wrong options that would also fit the gap.
   * It can only reject a draft, never approve one; a failed call or an unreadable answer returns nothing (the draft is kept for the reviewer).
   */
  private async optionsThatFit(exercise: Record<string, unknown>, model: string, signal?: AbortSignal): Promise<string[]> {
    const payload = exercise.payload as { options?: Array<{ id: string; text: string }>; accepted_option_ids?: string[] } | undefined;
    const keyId = payload?.accepted_option_ids?.[0];
    const options = payload?.options;
    if (!options || !keyId || options.length < 2) return [];
    const verdicts = await this.fitVerdicts(String(exercise.prompt_en), options.find((o) => o.id === keyId)?.text ?? "", options.filter((o) => o.id !== keyId), model, signal);
    return verdicts ? [...verdicts].filter(([, fits]) => fits).map(([id]) => id) : [];
  }

  /**
   * Words of the learner's own dictionary that are the same part of speech and shape as the target: wrong options that the program, not the model, chooses.
   * Part of speech comes from the latest saved revision of each word; words without one are skipped.
   */
  private distractorPool(lemma: string, ordinal: number): string[] {
    const rows = this.o.db.prepare(
      "SELECT e.lemma AS lemma, (SELECT r.part_of_speech FROM vocabulary_revisions r WHERE r.entry_id = e.id ORDER BY r.revision DESC LIMIT 1) AS pos FROM vocabulary_entries e",
    ).all() as Array<{ lemma: string; pos: string | null }>;
    const mine = rows.find((r) => r.lemma.toLowerCase() === lemma.toLowerCase());
    if (!mine?.pos || mine.pos === "unknown") return [];
    const shape = (w: string): number => Math.min(2, w.trim().split(/\s+/).length);
    const synonyms = new Set(this.synonymsFor(lemma).map((x) => x.toLowerCase()));
    const pool = rows.filter((r) => r.pos === mine.pos && r.lemma.toLowerCase() !== lemma.toLowerCase() && shape(r.lemma) === shape(lemma) && !synonyms.has(r.lemma.toLowerCase())).map((r) => r.lemma);
    // a stable shuffle per item: the same draft always meets the same candidates
    let h = (ordinal * 2654435761) >>> 0;
    return pool.map((w) => { h = (h * 1103515245 + 12345) >>> 0; return { w, k: h }; }).sort((x, y) => x.k - y.k).map((x) => x.w).slice(0, 8);
  }

  /**
   * Common words of the learner's 20k list that look like the target (same part of speech, same first letter, similar length, similar frequency):
   * wrong options that do not give the answer away by being the only unfamiliar word. Empty without the list.
   */
  private async lookalikes(lemma: string, pos: string, ordinal: number): Promise<string[]> {
    const all = await this.o.lexicon?.all();
    if (!all || all.size === 0 || /\s/.test(lemma)) return [];
    const target = all.get(lemma.toLowerCase());
    const want = pos.toLowerCase();
    const synonyms = new Set([...(target?.synonyms ?? []), ...this.synonymsFor(lemma)].map((x) => x.toLowerCase()));
    const freq = target?.frequency ?? null;
    const scored: Array<{ w: string; d: number }> = [];
    for (const [w, h] of all) {
      if (w === lemma.toLowerCase() || synonyms.has(w) || !/^[a-z]+$/.test(w)) continue;
      if (!h.partOfSpeech.toLowerCase().includes(want) || w[0] !== lemma[0]!.toLowerCase() || Math.abs(w.length - lemma.length) > 2) continue;
      if (h.frequency !== null && h.frequency < 1) continue;
      scored.push({ w, d: freq && h.frequency ? Math.abs(Math.log10(h.frequency + 1) - Math.log10(freq + 1)) : 1 });
    }
    scored.sort((a, b) => a.d - b.d || (a.w < b.w ? -1 : 1));
    const near = scored.slice(0, 12).map((x) => x.w);
    // a stable pick per item from the closest dozen
    return near.map((w, i) => ({ w, k: ((ordinal + 1) * 2654435761 + i * 40503) >>> 0 })).sort((a, b) => a.k - b.k).slice(0, 4).map((x) => x.w);
  }

  /**
   * Replace the model's wrong options with checked ones. v7: two dictionary words of the same part of speech. v8: a mix of the model's own options,
   * up to four studied words and up to four lookalikes from the 20k list, all read by the local model in ONE call; two that do not fit are taken,
   * at most one of them a studied word, so the familiar words do not reveal the unfamiliar answer. Only for a target in its base form.
   */
  private async replaceDistractors(built: Built, plan: ItemPlan, model: string, signal: AbortSignal | undefined, mix: boolean): Promise<Built | null> {
    if (!built.ok) return null;
    const e = built.exercise as { prompt_en: string; payload: { options?: Array<{ id: string; text: string }>; accepted_option_ids?: string[] }; vocabulary: { target: { lemma: string; surfaceForm: string; partOfSpeech?: string }; options?: Array<{ id: string; text: string; rationaleRu: string }>; acceptedOptionId?: string } };
    const options = e.payload.options, keyId = e.payload.accepted_option_ids?.[0];
    if (!options || !keyId || !e.vocabulary.options) return null;
    if (e.vocabulary.target.surfaceForm.toLowerCase() !== e.vocabulary.target.lemma.toLowerCase()) return null;
    const keyOpt = e.vocabulary.options.find((o) => o.id === keyId);
    if (!keyOpt) return null;
    type Cand = { id: string; text: string; from: "model" | "studied" | "lookalike"; rationaleRu: string };
    const seen = new Set([keyOpt.text.toLowerCase()]);
    const cands: Cand[] = [];
    const push = (text: string, from: Cand["from"], rationaleRu: string): void => {
      if (seen.has(text.toLowerCase())) return;
      seen.add(text.toLowerCase());
      cands.push({ id: `c${cands.length}`, text, from, rationaleRu });
    };
    const generic = (t: string): string => `«${t}» не подходит по смыслу в этом предложении.`;
    if (mix) for (const o of e.vocabulary.options) if (o.id !== keyId) push(o.text, "model", o.rationaleRu);
    for (const w of this.distractorPool(e.vocabulary.target.lemma, plan.ordinal).slice(0, mix ? 4 : 8)) push(w, "studied", generic(w));
    if (mix) for (const w of await this.lookalikes(e.vocabulary.target.lemma, e.vocabulary.target.partOfSpeech ?? "", plan.ordinal)) push(w, "lookalike", generic(w));
    if (cands.filter((c) => c.from !== "model").length === 0) return null;
    const verdicts = await this.fitVerdicts(e.prompt_en, keyOpt.text, cands.map(({ id, text }) => ({ id, text })), model, signal);
    if (!verdicts) return null;
    const safe = cands.filter((c) => verdicts.get(c.id) === false);
    const head = e.prompt_en.split("___")[0] ?? "";
    // preference: one unfamiliar word (lookalike or the model's own) first, then anything else, never two studied words in v8
    const rank = (c: Cand): number => (!mix ? 0 : c.from === "lookalike" ? 0 : c.from === "model" ? 1 : 2);
    const ordered = [...safe].sort((a, b) => rank(a) - rank(b) || (((plan.ordinal * 31 + Number(a.id.slice(1))) % 7) - ((plan.ordinal * 31 + Number(b.id.slice(1))) % 7)));
    let chosen: Cand[] | null = null;
    for (let i = 0; i < ordered.length && !chosen; i++) {
      for (let j = i + 1; j < ordered.length && !chosen; j++) {
        const pair = [ordered[i]!, ordered[j]!];
        if (mix && pair.every((c) => c.from === "studied")) continue;
        if (!articleMismatch(head, [keyOpt.text, ...pair.map((c) => c.text)])) chosen = pair;
      }
    }
    if (!chosen) return null;
    const list: Array<{ text: string; rationaleRu: string; key: boolean }> = chosen.map((c) => ({ text: c.text, rationaleRu: c.rationaleRu, key: false }));
    list.splice(plan.ordinal % 3, 0, { text: keyOpt.text, rationaleRu: keyOpt.rationaleRu, key: true });
    const withIds = list.map((o, i) => ({ id: "abc"[i]!, ...o }));
    const newKey = withIds.find((o) => o.key)!.id;
    const exercise = JSON.parse(JSON.stringify(built.exercise)) as Record<string, unknown> & typeof e;
    exercise.payload = { ...exercise.payload, options: withIds.map(({ id, text }) => ({ id, text })), accepted_option_ids: [newKey] };
    exercise.vocabulary = { ...exercise.vocabulary, options: withIds.map(({ id, text, rationaleRu }) => ({ id, text, rationaleRu })), acceptedOptionId: newKey };
    return { ok: true, exercise };
  }

  /**
   * v8 recall check: other English words the local model says would fit the gap. Only rivals with the answer's first letter and length count,
   * because the cue gives both. A failed call returns nothing (the draft goes on; the reviewer still reads it).
   */
  private async recallRivals(sentence: string, answer: string, accepted: readonly string[], model: string, signal?: AbortSignal): Promise<string[]> {
    try {
      const r = await this.o.chat.chat({
        model,
        messages: [
          { role: "system", content: RIVALS_SYSTEM },
          { role: "user", content: JSON.stringify({ sentence, answer }) },
        ],
        format: { type: "object", required: ["alternatives"], properties: { alternatives: { type: "array", items: { type: "string" } } } },
        options: { num_ctx: GENERATION_PARAMS.numCtx, num_predict: 120, temperature: 0, seed: GENERATION_PARAMS.seed },
        signal,
      });
      const list = (JSON.parse(r.text) as { alternatives?: unknown }).alternatives;
      if (!Array.isArray(list)) return [];
      const ok = new Set(accepted.map((a) => a.trim().toLowerCase()));
      const shape = (w: string): string => w.trim().toLowerCase().split(/\s+/).map((p) => `${p[0]}${p.length}`).join(" ");
      const want = shape(answer);
      return [...new Set(list.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()))].filter((x) => x && !ok.has(x) && shape(x) === want).slice(0, 3);
    } catch (err) {
      if (signal?.aborted || (err as Error).name === "AbortError") throw err;
      return [];
    }
  }

  /** a saved expression that contains the item's word (one of them, by ordinal), for the model to use when it fits; nothing when there is none */
  private expressionHint(plan: ItemPlan): { expression?: string } {
    const lemma = plan.vocabulary?.lemma;
    if (!lemma) return {};
    const phrases = expressionsForForms(this.o.db, matchForms(lemma, []));
    // only every third item carries the phrase, so expressions come back now and then and the sentences stay varied
    return phrases.length > 0 && plan.ordinal % 3 === 0 ? { expression: phrases[Math.floor(plan.ordinal / 3) % phrases.length]! } : {};
  }

  /** Up to 5 existing bank sentences with the item's word, evenly sampled, so a local model sees what to avoid without a long list. */
  private avoidSentences(plan: ItemPlan): string[] {
    const lemma = plan.vocabulary?.lemma;
    if (!lemma) return [];
    const rows = this.o.db.prepare(
      `SELECT DISTINCT u.canonical_text AS text FROM prompt_units u JOIN revision_prompt_units rpu ON rpu.unit_id = u.id
        WHERE u.canonical_text LIKE ? AND u.canonical_text NOT LIKE '%⟦%' ORDER BY u.canonical_text`,
    ).all(`%${lemma.replace(/[%_]/g, "")}%`) as Array<{ text: string }>;
    const cap = 5, step = rows.length / cap;
    const picked = rows.length <= cap ? rows : Array.from({ length: cap }, (_, k) => rows[Math.floor(k * step)]!);
    return picked.map(r => r.text.length > 140 ? r.text.slice(0, 140) : r.text);
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
          if (this.o.advisoryEnabled) enqueue(db, deps, { kind: "triage", payload: { revisionId: reg.revisionId }, idempotencyKey: `advisory:${reg.revisionId}:${SCREEN_PROMPT}`, priority: 3 });
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
