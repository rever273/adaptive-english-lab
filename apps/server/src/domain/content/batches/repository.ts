import { randomUUID } from "node:crypto";
import { CreateBatchRequestSchema, EXERCISE_TYPES, difficultyLevels, TRIAL_PER_TYPE, TRIAL_SIZE } from "@english-lab/contracts";
import type { z } from "zod";
import type { Db } from "../../../db/open.js";
import { ApiError } from "../../../errors.js";
import { enqueue } from "../../../queue/jobs.js";
import { ensurePromptVersion } from "../../ai/prompts.js";
import { draftFormatsText } from "./draftFormats.js";
import { lessonPlanView } from "./lessonNeeds.js";
import { groupUnits, planBatch, planFromDeficits, type ItemPlan, type LessonDemand } from "./plan.js";
import { taxonomyForNewRevisions } from "../repository.js";
import { exportVocabulary } from "../../vocabulary/practice.js";
import { loadBlockedFingerprints, loadCandidates } from "../../sessions/bank.js";
import { loadBlueprint, loadSettings } from "../../sessions/policy.js";
import { vocabularyFormat } from "./vocabularyDrafts.js";

export const GENERATION_PROMPT = "generation-v5";
/** a skill is "covered" when it has this many released (selectable) exercises; below it the coverage view reports a deficit (D46) */
export const TARGET_SELECTABLE_PER_SKILL = 12;

/**
 * A trial opens the gate only if enough of its 24 drafts were actually APPROVED by an individual review (D47). "Everything reviewed"
 * alone is not enough: a prompt whose 24 drafts were all rejected has been measured, not accepted. The threshold is a project choice
 * (spec/05 does not give one) and is meant to be tightened, not loosened.
 */
export const TRIAL_MIN_APPROVED = 18;

export interface BatchDeps {
  now: () => Date;
  newId: () => string;
}
export const defaultBatchDeps: BatchDeps = { now: () => new Date(), newId: randomUUID };

/** Reported item status: derived from the immutable content events, never from a copied flag. */
export type ItemStatus = "queued" | "invalid" | "generated" | "ready_for_review" | "approved" | "released" | "flagged" | "rejected";
const STATUSES: readonly ItemStatus[] = ["queued", "invalid", "generated", "ready_for_review", "approved", "released", "flagged", "rejected"];

interface ItemRow {
  id: string;
  ordinal: number;
  state: string;
  plan_json: string;
  revision_id: string | null;
  job_id: string | null;
  error_json: string | null;
  content_status: string | null;
  content_hash: string | null;
  released: number;
  reviews: number;
  outcome: string | null;
  job_state: string | null;
}

const ITEM_SQL = `
  SELECT bi.id, bi.ordinal, bi.state, bi.plan_json, COALESCE(bo.final_revision_id, bi.revision_id) AS revision_id, bi.job_id, bi.error_json, bo.action AS outcome, j.state AS job_state,
         s.status AS content_status, er.content_hash AS content_hash,
         EXISTS (SELECT 1 FROM selectable_revisions sr WHERE sr.revision_id = COALESCE(bo.final_revision_id, bi.revision_id)) AS released,
         (SELECT COUNT(*) FROM content_reviews cr WHERE cr.revision_id = COALESCE(bo.final_revision_id, bi.revision_id)) AS reviews
    FROM batch_items bi
    LEFT JOIN jobs j ON j.id = bi.job_id
    LEFT JOIN batch_outcomes bo ON bo.batch_id = bi.batch_id AND bo.ordinal = bi.ordinal
    LEFT JOIN latest_content_state s ON s.revision_id = COALESCE(bo.final_revision_id, bi.revision_id)
    LEFT JOIN exercise_revisions er ON er.id = COALESCE(bo.final_revision_id, bi.revision_id)
   WHERE bi.batch_id = ?
   ORDER BY bi.ordinal`;

function statusOf(r: ItemRow): ItemStatus {
  if (r.outcome === "reject") return "rejected";
  if (!r.outcome && r.state === "queued" && (r.job_state === "failed" || r.job_state === "cancelled")) return "invalid";
  if (r.state === "queued" && !r.outcome) return "queued";
  if (r.state === "invalid" && !r.outcome) return "invalid";
  switch (r.content_status) {
    case "pending_review":
      return "ready_for_review";
    case "approved":
      return r.released ? "released" : "approved";
    case "flagged":
      return "flagged";
    case "rejected":
      return "rejected";
    default:
      return "generated"; // draft / validated
  }
}

export interface BatchView {
  id: string;
  createdAt: string;
  mode: string;
  purpose: "trial" | "scale";
  category: "grammar" | "vocabulary";
  completion: { accepted: number; corrected: number; rejected: number; flagged: number; total: number } | null;
  requestedCount: number;
  promptVersion: string;
  /** actual row counts per reported status; they always sum to requestedCount */
  counts: Record<ItemStatus, number>;
  /** items with an individual review or a recorded final agent disposition */
  reviewedItems: number;
  /** nothing is queued: every item has either produced a draft or been quarantined as invalid */
  generationDone: boolean;
  /** every item is resolved: invalid, or reviewed and approved/flagged/rejected. Says nothing about a release. */
  resolved: boolean;
  items?: Array<{ ordinal: number; status: ItemStatus; plan: ItemPlan; revisionId: string | null; contentHash: string | null; reviews: number; jobId: string | null; error: unknown; /** hints from the cheap screening model; advice only, absent until the screen has run */ advisory: { source: string; flags: unknown[] } | null }>;
}

export function getBatch(db: Db, id: string, withItems = true): BatchView {
  const b = db.prepare("SELECT id, created_at, mode, purpose, requested_count, prompt_version_id, spec_json FROM batches WHERE id = ?").get(id) as { id: string; created_at: string; mode: string; purpose: "trial" | "scale"; requested_count: number; prompt_version_id: string; spec_json: string } | undefined;
  if (!b) throw new ApiError(404, "BATCH_NOT_FOUND", "Unknown batch");
  const rows = db.prepare(ITEM_SQL).all(id) as ItemRow[];
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<ItemStatus, number>;
  let reviewed = 0;
  let resolved = true;
  for (const r of rows) {
    const st = statusOf(r);
    counts[st]++;
    if (r.reviews > 0 || r.outcome) reviewed++;
    if (!(st === "invalid" || (r.reviews > 0 && (st === "approved" || st === "released" || st === "flagged" || st === "rejected")))) resolved = false;
  }
  const view: BatchView = {
    id: b.id,
    createdAt: b.created_at,
    mode: b.mode,
    purpose: b.purpose,
    category: (JSON.parse(b.spec_json) as { category?: "grammar" | "vocabulary" }).category ?? "grammar",
    completion: (() => { const r = db.prepare("SELECT result_json AS r FROM batch_completions WHERE batch_id = ?").get(id) as { r: string } | undefined; return r ? JSON.parse(r.r) : null; })(),
    requestedCount: b.requested_count,
    promptVersion: b.prompt_version_id,
    counts,
    reviewedItems: reviewed,
    generationDone: counts.queued === 0,
    resolved: !!db.prepare("SELECT 1 FROM batch_completions WHERE batch_id = ?").get(id) || resolved,
  };
  if (withItems) {
    view.items = rows.map((r) => ({ ordinal: r.ordinal, status: statusOf(r), plan: JSON.parse(r.plan_json) as ItemPlan, revisionId: r.revision_id, contentHash: r.content_hash, reviews: r.reviews, jobId: r.job_id, error: r.error_json ? JSON.parse(r.error_json) : null, advisory: advisoryOf(db, r.revision_id) }));
  }
  return view;
}

function advisoryOf(db: Db, revisionId: string | null): { source: string; flags: unknown[] } | null {
  if (!revisionId) return null;
  const a = db.prepare("SELECT source, flags_json FROM advisory_signals WHERE revision_id = ? ORDER BY rowid DESC LIMIT 1").get(revisionId) as { source: string; flags_json: string } | undefined;
  return a ? { source: a.source, flags: JSON.parse(a.flags_json) as unknown[] } : null;
}

export function listBatches(db: Db): Array<Omit<BatchView, "items">> {
  return (db.prepare("SELECT id FROM batches ORDER BY created_at DESC, rowid DESC").all() as Array<{ id: string }>).map((b) => getBatch(db, b.id, false));
}

export interface TrialGate {
  passed: boolean;
  /** the trial batch that opens the gate (latest fully resolved trial of the CURRENT generation prompt version) */
  trialBatchId: string | null;
  reason: string;
  promptVersion: string;
}

/**
 * Trial24 gate (spec/05): a larger batch needs a 24-draft trial of the current generation prompt in which every item is resolved and
 * every generated draft has been individually reviewed. A new prompt version needs a new trial.
 */
export function trialGate(db: Db, promptVersion = GENERATION_PROMPT): TrialGate {
  const trials = db.prepare("SELECT id FROM batches WHERE purpose = 'trial' AND prompt_version_id = ? ORDER BY created_at DESC, rowid DESC").all(promptVersion) as Array<{ id: string }>;
  if (trials.length === 0) return { passed: false, trialBatchId: null, reason: `no trial batch exists for ${promptVersion}`, promptVersion };
  let lastReason = "";
  for (const t of trials) {
    const v = getBatch(db, t.id, false);
    const approved = (db.prepare("SELECT COUNT(*) AS n FROM batch_items bi WHERE bi.batch_id = ? AND EXISTS (SELECT 1 FROM content_reviews cr WHERE cr.revision_id = bi.revision_id AND cr.verdict = 'approved')").get(t.id) as { n: number }).n;
    if (!v.resolved) {
      lastReason = `trial ${t.id} is not fully resolved (${v.counts.queued} queued, ${v.counts.generated + v.counts.ready_for_review} awaiting review)`;
      continue;
    }
    if (approved < TRIAL_MIN_APPROVED) {
      lastReason = `trial ${t.id} is fully reviewed but only ${approved} of ${v.requestedCount} drafts were approved (at least ${TRIAL_MIN_APPROVED} are needed): fix the prompt and run a new trial`;
      continue;
    }
    return { passed: true, trialBatchId: t.id, reason: `a fully reviewed trial exists (${approved}/${v.requestedCount} approved)`, promptVersion };
  }
  return { passed: false, trialBatchId: null, reason: lastReason, promptVersion };
}

export interface CreatedBatch {
  batchId: string;
  purpose: "trial" | "scale";
  items: number;
  units: number;
}

/**
 * Stores the request, its items and one queued job per inference unit in ONE transaction. No model is called here; the dispatcher
 * runs the units later, so closing the browser or restarting the server never loses the batch.
 */
export function createBatch(db: Db, deps: BatchDeps, input: z.input<typeof CreateBatchRequestSchema>): CreatedBatch {
  const request = CreateBatchRequestSchema.parse(input);
  const purpose: "trial" | "scale" = request.trial ? "trial" : "scale";
  return db
    .transaction((): CreatedBatch => {
      // Regular replenishment is protected by per-revision independent review, not a trial approval percentage.
      const tax = taxonomyForNewRevisions(db);
      const coverage = new Map<string, number>();
      const blocked = loadBlockedFingerprints(db);
      for (const c of loadCandidates(db, "practice")) {
        if (c.unitFingerprints.length && c.unitFingerprints.every(f => !blocked.has(f))) coverage.set(c.skillId, (coverage.get(c.skillId) ?? 0) + 1);
      }

      const batchId = deps.newId();
      let plans: ItemPlan[];
      if (request.category === "vocabulary") {
        if (request.trial) throw new ApiError(422, "NO_VOCABULARY_TRIAL", "Vocabulary replenishment uses regular batches");
        const words = (exportVocabulary(db).json as { words: Array<{ lemma: string; translationRu: string | null; learned: boolean; newExercises: number }> }).words;
        if (!words.length) throw new ApiError(409, "DICTIONARY_EMPTY", "Save words in your dictionary before creating vocabulary exercises");
        words.sort((a, b) => Number(a.learned) - Number(b.learned) || a.newExercises - b.newExercises || a.lemma.localeCompare(b.lemma));
        plans = Array.from({ length: request.count }, (_, ordinal) => {
          const word = words[ordinal % words.length]!;
          const family = (["recognition", "guided_recall", "recognition", "collocation", "guided_recall"] as const)[Math.floor(ordinal / words.length) % 5]!;
          const type = family === "guided_recall" ? "guided_short_answer" : family === "collocation" ? "choose_form" : "choose_missing_fragment";
          return { ordinal, type, dimension: family === "guided_recall" ? "production" : "recognition", target_skill: "collocations.natural_phrases", topic: "everyday", context_id: `vocab-${batchId.slice(0, 8)}-${ordinal}`, vocabulary: { lemma: word.lemma, translationRu: word.translationRu, family } };
        });
      } else {
        // D68: an adaptive batch is planned from the DEFICITS of the next lesson (then the following lessons), not from the last played one
        const view = request.mode === "adaptive" && !request.trial && !request.skills?.length ? lessonPlanView(db, deps.now()) : null;
        if (view) {
          const lessons: LessonDemand[] = view.lessons.slice(view.nextIndex).map((n) => ({
            key: n.key,
            formatDeficit: Object.fromEntries((n.formats.some((f) => f.deficit > 0) ? n.formats.filter((f) => f.deficit > 0).map((f) => [f.format, f.deficit]) : n.deficit > 0 ? n.formats.map((f) => [f.format, f.need]) : []) as Array<[string, number]>),
            skills: n.skills.length > 0
              ? [...n.skills].sort((a, b) => b.deficit - a.deficit || a.have - b.have || (a.skill < b.skill ? -1 : 1)).map((k) => k.skill)
              : [...tax.skills].sort((a, b) => (coverage.get(a) ?? 0) - (coverage.get(b) ?? 0) || (a < b ? -1 : 1)), // no skill pool: the thinnest skills of the taxonomy
            capacity: n.recommended,
          }));
          plans = planFromDeficits({ count: request.count, lessons, ...(request.types ? { types: request.types } : {}), tag: batchId.slice(0, 8) });
        } else {
        // Replenish the current lesson's skill pool without changing session selection or its weakness algorithm.
        const last = db.prepare("SELECT blueprint_revision_id AS id FROM sessions WHERE purpose = 'practice' AND blueprint_revision_id IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string } | undefined;
        const policy = !request.skills?.length && !request.trial && last ? loadBlueprint(db, last.id).policy : null;
        const pool = policy?.skillPool ?? [];
        const lessonTypes = policy ? EXERCISE_TYPES.filter(t => t === "context_reading" ? policy.readingBlocks > 0 && (!pool.length || pool.some(s => /^linking\./.test(s))) : policy.quotas[t] > 0 && (t !== "choose_missing_fragment" || !pool.length || pool.some(s => /^(prepositions|articles|countability|linking|verb_patterns)\./.test(s)))) : undefined;
        const scoped = { ...request, ...(pool.length ? { skills: pool } : {}), ...(!request.types && lessonTypes?.length ? { types: lessonTypes } : {}) };
        plans = planBatch({ request: scoped, taxonomySkills: [...tax.skills], coverage, tag: batchId.slice(0, 8) });
        }
        // the learners target difficulty range (Settings): new content is requested at those levels in turn; unset keeps the historical B2
        const levels = difficultyLevels(loadSettings(db).values);
        if (levels) plans = plans.map((p) => ({ ...p, level: levels[p.ordinal % levels.length]! }));
      }
      const promptVersionId = ensurePromptVersion(db, request.category === "vocabulary" ? "vocabulary-generation-v2" : GENERATION_PROMPT, request.category === "vocabulary" ? JSON.stringify(vocabularyFormat(2)) : draftFormatsText());
      const now = deps.now().toISOString();
      const count = purpose === "trial" ? TRIAL_SIZE : request.count;
      db.prepare("INSERT INTO batches(id, requested_count, mode, purpose, prompt_version_id, spec_json, created_at) VALUES (?,?,?,?,?,?,?)").run(batchId, count, request.mode, purpose, promptVersionId, JSON.stringify({ category: request.category, skills: request.skills ?? null, types: purpose === "trial" ? [...EXERCISE_TYPES] : (request.types ?? null), perTypeTrial: TRIAL_PER_TYPE }), now);
      const insItem = db.prepare("INSERT INTO batch_items(id, batch_id, ordinal, plan_json, state, updated_at) VALUES (?,?,?,?,?,?)");
      for (const p of plans) insItem.run(deps.newId(), batchId, p.ordinal, JSON.stringify(p), "queued", now);

      const units = groupUnits(plans);
      const setJob = db.prepare("UPDATE batch_items SET job_id = ? WHERE batch_id = ? AND ordinal = ?");
      for (const u of units) {
        const ordinals = u.map((p) => p.ordinal);
        const { job } = enqueue(db, deps, { kind: "generation", payload: { batchId, ordinals }, idempotencyKey: `generation:${batchId}:${ordinals[0]}`, batchId, priority: 3 });
        for (const o of ordinals) setJob.run(job.id, batchId, o);
      }
      return { batchId, purpose, items: plans.length, units: units.length };
    })
    .immediate();
}

// ---------------------------------------------------------------------------------------------------------------- coverage

export interface CoverageView {
  targetPerSkill: number;
  skills: Array<{ skill: string; released: number; approvedUnreleased: number; inReview: number; draft: number; flagged: number; rejected: number; deficit: number }>;
  byType: Record<string, { released: number; inReview: number }>;
  totals: { skills: number; skillsWithDeficit: number; releasedExercises: number };
}

export function coverage(db: Db): CoverageView {
  const tax = taxonomyForNewRevisions(db);
  const rows = db.prepare(
    `SELECT sr.skill_id AS skill, s.status AS status, er.type AS type,
            EXISTS (SELECT 1 FROM selectable_revisions x WHERE x.revision_id = er.id) AS released
       FROM exercise_skills es
       JOIN skill_revisions sr ON sr.id = es.skill_revision_id
       JOIN exercise_revisions er ON er.id = es.revision_id
       JOIN latest_content_state s ON s.revision_id = er.id
      WHERE es.role = 'target' AND er.bank_role = 'practice' AND json_type(er.content_json, '$.vocabulary') IS NULL`,
  ).all() as Array<{ skill: string; status: string; type: string; released: number }>;
  const skills = new Map([...tax.skills].sort().map((k) => [k, { skill: k, released: 0, approvedUnreleased: 0, inReview: 0, draft: 0, flagged: 0, rejected: 0, deficit: 0 }]));
  const byType: CoverageView["byType"] = {};
  for (const r of rows) {
    const e = skills.get(r.skill);
    if (!e) continue;
    const t = (byType[r.type] ??= { released: 0, inReview: 0 });
    if (r.status === "approved") {
      if (r.released) (e.released++, t.released++);
      else e.approvedUnreleased++;
    } else if (r.status === "pending_review") (e.inReview++, t.inReview++);
    else if (r.status === "flagged") e.flagged++;
    else if (r.status === "rejected") e.rejected++;
    else e.draft++;
  }
  for (const e of skills.values()) e.deficit = Math.max(0, TARGET_SELECTABLE_PER_SKILL - e.released);
  const list = [...skills.values()];
  return { targetPerSkill: TARGET_SELECTABLE_PER_SKILL, skills: list, byType, totals: { skills: list.length, skillsWithDeficit: list.filter((s) => s.deficit > 0).length, releasedExercises: list.reduce((a, s) => a + s.released, 0) } };
}
