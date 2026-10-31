import { z } from "zod";
import { REVIEW_CHECKLIST_KEYS, ReviewChecklistSchema } from "@english-lab/contracts";
import type { Db } from "../../../db/open.js";
import { ApiError } from "../../../errors.js";
import { contentHashOf, jaccard, trigrams } from "../normalize.js";
import { validateExercise } from "../validator.js";
import { approveRevision, checkDuplicates, flagRevision, latestState, publishRelease, registerRevision, rejectRevision, submitForReview, submitReview, taxonomyForNewRevisions, type ContentDeps } from "../repository.js";
import { getBatch } from "./repository.js";
import { exerciseIdFor } from "./generationRunner.js";

const Agent = z.string().regex(/^agent:[^\s@]+@\S+$/);
const Decision = z.object({
  ordinal: z.number().int().min(0),
  expected_revision_id: z.string().nullable(),
  expected_content_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  action: z.enum(["keep", "replace", "reject"]),
  reason: z.string().trim().min(1).max(2000),
  content: z.record(z.string(), z.unknown()).optional(),
  patch: z.record(z.string(), z.unknown()).optional(),
}).strict();
export const CompletionPlanSchema = z.object({
  schema_version: z.literal("batch-completion-plan-v1"),
  batch_id: z.string().uuid(),
  author: Agent,
  items: z.array(Decision).min(1).max(500),
}).strict();
const FinalReviewSchema = z.object({
  schema_version: z.literal("content-review-v1"),
  reviewer: Agent,
  review_version: z.string().min(1).max(120),
  items: z.array(z.object({
    ordinal: z.number().int().min(0),
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    verdict: z.enum(["approved", "flagged", "rejected"]),
    checklist: ReviewChecklistSchema,
    reason: z.string().trim().min(1).max(2000),
  }).strict()).max(500),
}).strict();
export const CompleteBatchSchema = z.object({ plan: CompletionPlanSchema, review: FinalReviewSchema }).strict();
type Content = Record<string, unknown> & { id: string; revision: number; target_skill: string; template_cluster: string; bank_role: string; provenance: { origin: string; model_tag: string | null }; vocabulary?: { target: { lemma: string }; family: string } };
function fail(code: string, message: string, details?: unknown): never { throw new ApiError(409, code, message, details); }
const identity = (a: string) => a.split("@")[0]!.toLowerCase();
const PATCH_FIELDS = new Set(["prompt_en", "hints_ru", "explanation_ru", "payload", "difficulty", "context_level", "template_cluster", "sources", "vocabulary"]);
/** Objects merge recursively; arrays replace. No object assignment through user-controlled prototype keys. */
function mergePatch(base: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const b = base && typeof base === "object" && !Array.isArray(base) ? base as Record<string, unknown> : {};
  return Object.fromEntries([...new Set([...Object.keys(b), ...Object.keys(patch)])].map(k => [k, Object.hasOwn(patch, k) ? mergePatch(b[k], (patch as Record<string, unknown>)[k]) : b[k]]));
}

/** Read-only, even for replacement candidates: no speculative inserts, migrations or temporary DB writes. */
export function prepareCompletion(db: Db, input: unknown) {
  const plan = CompletionPlanSchema.parse(input);
  const batch = getBatch(db, plan.batch_id);
  if (!batch.generationDone) fail("GENERATION_UNFINISHED", "Wait until every generation item has settled");
  if (db.prepare("SELECT 1 FROM batch_completions WHERE batch_id = ?").get(plan.batch_id)) fail("BATCH_COMPLETED", "This batch is already completed");
  if (plan.items.length !== batch.requestedCount || new Set(plan.items.map(i => i.ordinal)).size !== batch.requestedCount) fail("INCOMPLETE_DECISIONS", "Exactly one decision is required for every ordinal");
  const tax = taxonomyForNewRevisions(db);
  const candidates: Array<{ ordinal: number; content_hash: string; content: Content; checks: ReturnType<typeof checkDuplicates>; author: string }> = [];
  const claimed = new Map<string, number>();
  const units: Array<{ ordinal: number; text: string }> = [];
  for (const d of plan.items) {
    const original = batch.items!.find(i => i.ordinal === d.ordinal);
    if (!original || original.revisionId !== d.expected_revision_id || original.contentHash !== d.expected_content_hash) fail("STALE_PLAN", `Item ${d.ordinal}: original revision/hash changed`);
    if (d.action !== "replace" && (d.content !== undefined || d.patch !== undefined)) fail("UNEXPECTED_CONTENT", `Item ${d.ordinal}: only replace accepts content/patch`);
    if (d.content && d.patch) fail("UNEXPECTED_CONTENT", `Item ${d.ordinal}: use content or patch, not both`);
    if (original.status === "released" || original.status === "approved" || original.status === "rejected") fail("ITEM_ALREADY_RESOLVED", `Item ${d.ordinal}: already ${original.status}`);
    if (d.action === "reject") continue;
    const stored = original.revisionId ? db.prepare("SELECT content_json AS c FROM exercise_revisions WHERE id = ?").get(original.revisionId) as { c: string } : null;
    const old = stored ? JSON.parse(stored.c) as Content : null;
    const expectedId = old?.id ?? exerciseIdFor(plan.batch_id, d.ordinal);
    const skeleton = { schema_version: "exercise-v1", id: expectedId, status: "draft", target_skill: original.plan.target_skill, additional_skills: [], type: original.plan.type, dimension: original.plan.dimension, difficulty: original.plan.level ?? "B2", context_level: original.plan.level === "C1" ? "C1" : "B2", topic: original.plan.topic, context_id: original.plan.context_id, template_cluster: `agent-${expectedId}`, bank_role: "practice", sources: [], rubric_version: "rubric-v1" };
    if (d.patch && Object.keys(d.patch).some(k => !PATCH_FIELDS.has(k))) fail("PATCH_FIELD", `Item ${d.ordinal}: patch changes protected metadata`);
    const replacement = d.patch ? { ...mergePatch(old ?? skeleton, d.patch) as Record<string, unknown>, revision: (old?.revision ?? 0) + 1, status: "draft", provenance: { origin: "agent", model_tag: null, model_digest: null, prompt_version: "agent-batch-correction-v1" } } : d.content;
    const content = (d.action === "keep" ? old : replacement) as Content | undefined;
    if (!content) fail("MISSING_CONTENT", `Item ${d.ordinal}: replacement content is required`);
    const v = validateExercise(content, { taxonomySkillIds: tax.skills });
    if (!v.ok) fail("CONTENT_INVALID", `Item ${d.ordinal}: validation failed`, v.errors);
    if (content.id !== expectedId || content.revision !== (d.action === "replace" ? (old?.revision ?? 0) + 1 : old?.revision)) fail("REVISION_SEQUENCE", `Item ${d.ordinal}: preserve exercise id and increment revision only for replacement`);
    if (content.target_skill !== original.plan.target_skill || content.type !== original.plan.type || content.bank_role !== "practice") fail("PLAN_CHANGED", `Item ${d.ordinal}: preserve planned skill, format and practice role`);
    if (original.plan.vocabulary) {
      if (content.vocabulary?.target.lemma.toLowerCase() !== original.plan.vocabulary.lemma.toLowerCase() || content.vocabulary.family !== original.plan.vocabulary.family) fail("TARGET_CHANGED", `Item ${d.ordinal}: preserve the planned dictionary word and family`);
    } else if (content.vocabulary) fail("CATEGORY_CHANGED", `Item ${d.ordinal}: grammar cannot become vocabulary`);
    if (d.action === "replace" && content.provenance?.origin !== "agent") fail("AUTHOR_PROVENANCE", `Item ${d.ordinal}: record agent provenance for corrections`);
    const checks = checkDuplicates(db, { exerciseId: content.id, templateCluster: content.template_cluster, targetSkill: content.target_skill, units: v.units });
    if (checks.errors.length) fail("DUPLICATE_CONTENT", `Item ${d.ordinal}: duplicate sentence`, checks.errors);
    for (const u of v.units) {
      const prior = claimed.get(u.fingerprint);
      if (prior !== undefined && prior !== d.ordinal) fail("BATCH_DUPLICATE", `Items ${prior} and ${d.ordinal} repeat a sentence`);
      claimed.set(u.fingerprint, d.ordinal);
      units.push({ ordinal: d.ordinal, text: u.text });
    }
    candidates.push({ ordinal: d.ordinal, content_hash: v.contentHash!, content, checks, author: d.action === "replace" ? plan.author : `model:${content.provenance.model_tag ?? content.provenance.origin}` });
  }
  // Supply only relevant comparison text, not the entire bank or held-out answer keys.
  const comparisons = db.prepare("SELECT u.canonical_text AS text, er.bank_role AS role FROM exercise_revisions er JOIN revision_prompt_units r ON r.revision_id = er.id JOIN prompt_units u ON u.id = r.unit_id WHERE er.id = ?");
  return {
    schema_version: "batch-final-review-packet-v1", batch_id: plan.batch_id, author: plan.author,
    items: candidates.map(c => ({ ...c, comparisons: c.checks.near.flatMap(n => comparisons.all(n.otherRevisionId)), batchNear: units.filter(u => u.ordinal !== c.ordinal && units.some(m => m.ordinal === c.ordinal && jaccard(trigrams(m.text), trigrams(u.text)) >= 0.8)) })),
    reviewManifestTemplate: { schema_version: "content-review-v1", reviewer: "agent:<independent-reviewer>@<version>", review_version: "final-review-v1", items: candidates.map(c => ({ ordinal: c.ordinal, content_hash: c.content_hash, verdict: "", checklist: Object.fromEntries(REVIEW_CHECKLIST_KEYS.map(k => [k, null])), reason: "" })) },
  };
}

/** Atomic check + review + publication + receipt. Original revisions and attempt history stay untouched. */
export function completeBatch(db: Db, deps: ContentDeps, input: unknown) {
  const parsed = CompleteBatchSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "Invalid batch completion", parsed.error.issues);
  const { plan, review } = parsed.data;
  const hash = contentHashOf(parsed.data);
  return db.transaction(() => {
    const prior = db.prepare("SELECT input_hash AS hash, result_json AS result FROM batch_completions WHERE batch_id = ?").get(plan.batch_id) as { hash: string; result: string } | undefined;
    if (prior) {
      if (prior.hash !== hash) fail("COMPLETION_CONFLICT", "Batch was completed with a different input");
      return { ...JSON.parse(prior.result), replayed: true };
    }
    const packet = prepareCompletion(db, plan);
    if (review.items.length !== packet.items.length || new Set(review.items.map(i => i.ordinal)).size !== packet.items.length) fail("INCOMPLETE_REVIEW", "Every final candidate needs exactly one individual review");
    for (const c of packet.items) {
      const r = review.items.find(i => i.ordinal === c.ordinal);
      if (!r || r.content_hash !== c.content_hash) fail("STALE_REVIEW", `Item ${c.ordinal}: review does not match final hash`);
      if (r.verdict === "flagged") fail("UNRESOLVED_REVIEW", `Item ${c.ordinal}: repair and re-review, or reject the ordinal before completing the batch`);
      if (identity(review.reviewer) === identity(c.author)) fail("SELF_REVIEW", `Item ${c.ordinal}: correction author cannot review their own revision`);
      if (r.verdict === "approved" && REVIEW_CHECKLIST_KEYS.some(k => r.checklist[k] !== true && !(r.checklist[k] === "n/a" && ["distractors_valid", "no_mistake_case_correct"].includes(k)))) fail("CHECKLIST_INCOMPLETE", `Item ${c.ordinal}: approval requires every applicable check`);
    }
    const batch = getBatch(db, plan.batch_id);
    const actor = { type: "agent" as const, id: review.reviewer };
    const author = { type: "agent" as const, id: plan.author };
    const release: string[] = [];
    let corrected = 0, flagged = 0, rejected = 0;
    const outcomes: Array<{ ordinal: number; original: string | null; final: string | null; action: string; reason: string }> = [];
    for (const d of plan.items) {
      const original = batch.items!.find(i => i.ordinal === d.ordinal)!;
      if (d.action === "reject") {
        if (original.revisionId) rejectRevision(db, deps, { revisionId: original.revisionId, actor: author, reason: d.reason });
        rejected++;
        outcomes.push({ ordinal: d.ordinal, original: original.revisionId, final: original.revisionId, action: d.action, reason: d.reason });
        continue;
      }
      const c = packet.items.find(i => i.ordinal === d.ordinal)!;
      const r = review.items.find(i => i.ordinal === d.ordinal)!;
      let revisionId = original.revisionId!;
      if (d.action === "replace") {
        const reg = registerRevision(db, deps, { content: c.content, actor: author, sourceBatchId: plan.batch_id, reason: d.reason });
        if (reg.replayed) fail("REVISION_EXISTS", "Replacement was already registered outside this completion");
        revisionId = reg.revisionId;
        submitForReview(db, deps, revisionId, author);
        if (original.revisionId && latestState(db, original.revisionId)?.status !== "flagged") flagRevision(db, deps, { revisionId: original.revisionId, actor: author, reason: `Superseded: ${d.reason}` });
        corrected++;
      }
      submitReview(db, deps, { revisionId, contentHash: c.content_hash, reviewer: review.reviewer, reviewVersion: review.review_version, checklist: r.checklist, verdict: r.verdict });
      if (r.verdict === "approved") { approveRevision(db, deps, { revisionId, actor, reason: r.reason }); release.push(revisionId); }
      else if (r.verdict === "rejected") { rejectRevision(db, deps, { revisionId, actor, reason: r.reason }); rejected++; }
      else { if (latestState(db, revisionId)?.status !== "flagged") flagRevision(db, deps, { revisionId, actor, reason: r.reason }); flagged++; }
      outcomes.push({ ordinal: d.ordinal, original: original.revisionId, final: revisionId, action: d.action, reason: r.reason });
    }
    if (release.length) publishRelease(db, deps, { revisionIds: release, reviewer: review.reviewer });
    const result = { batchId: plan.batch_id, accepted: release.length, corrected, rejected, flagged, total: plan.items.length, replayed: false };
    db.prepare("INSERT INTO batch_completions(batch_id,input_hash,result_json,created_at) VALUES (?,?,?,?)").run(plan.batch_id, hash, JSON.stringify(result), deps.now().toISOString());
    for (const o of outcomes) db.prepare("INSERT INTO batch_outcomes(batch_id,ordinal,original_revision_id,final_revision_id,action,reason,author) VALUES (?,?,?,?,?,?,?)").run(plan.batch_id, o.ordinal, o.original, o.final, o.action, o.reason, plan.author);
    return result;
  }).immediate();
}

export function completionPlanTemplate(db: Db, batchId: string) {
  const batch = getBatch(db, batchId);
  return { schema_version: "batch-completion-plan-v1", batch_id: batchId, author: "agent:<author>@<version>", items: batch.items!.map(i => ({ ordinal: i.ordinal, expected_revision_id: i.revisionId, expected_content_hash: i.contentHash, action: i.revisionId ? "keep" : "reject", reason: "" })) };
}
