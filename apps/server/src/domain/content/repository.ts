import { createHash, randomUUID } from "node:crypto";
import {
  NA_ALLOWED_KEYS,
  REVIEW_CHECKLIST_KEYS,
  ReviewChecklistSchema,
  ReviewerSchema,
  type ActorType,
  type ContentStatus,
  type PromptUnitFingerprint,
  type ReviewChecklist,
  type ValidationIssue,
} from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { NEAR_DUPLICATE_THRESHOLD, NORMALIZER_VERSION, canonicalJson, jaccard, trigrams } from "./normalize.js";
import { recordBankEncountersForRevisions } from "../vocabulary/repository.js";
import { validateExercise } from "./validator.js";

export interface ContentDeps {
  now: () => Date;
  newId: () => string;
}
export const defaultContentDeps: ContentDeps = { now: () => new Date(), newId: randomUUID };

export interface Actor {
  type: ActorType;
  id: string;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const REVIEWER_PREFIX: Partial<Record<ActorType, string>> = { user: "human:", agent: "agent:" };

export function latestState(db: Db, revisionId: string): { status: ContentStatus; sequence: number } | undefined {
  return db.prepare("SELECT status, sequence FROM latest_content_state WHERE revision_id = ?").get(revisionId) as { status: ContentStatus; sequence: number } | undefined;
}

export const isSelectable = (db: Db, revisionId: string): boolean => db.prepare("SELECT 1 FROM selectable_revisions WHERE revision_id = ?").get(revisionId) !== undefined;

function revisionRow(db: Db, revisionId: string) {
  const r = db.prepare("SELECT id, exercise_id AS exerciseId, revision, content_hash AS contentHash, content_json AS contentJson, taxonomy_id AS taxonomyId, template_cluster AS templateCluster FROM exercise_revisions WHERE id = ?").get(revisionId) as
    | { id: string; exerciseId: string; revision: number; contentHash: string; contentJson: string; taxonomyId: string; templateCluster: string }
    | undefined;
  if (!r) throw new ApiError(404, "REVISION_NOT_FOUND", "Unknown exercise revision");
  return r;
}

function appendState(db: Db, deps: ContentDeps, revisionId: string, to: ContentStatus, actor: Actor, reason: string): number {
  const rev = revisionRow(db, revisionId);
  const last = latestState(db, revisionId);
  const sequence = (last?.sequence ?? 0) + 1;
  try {
    db.prepare(
      `INSERT INTO content_state_events(id, revision_id, sequence, from_status, to_status, actor_type, actor_id, reason, content_hash, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(deps.newId(), revisionId, sequence, last?.status ?? null, to, actor.type, actor.id, reason, rev.contentHash, deps.now().toISOString());
  } catch (e) {
    // The triggers are the backstop; surface their verdict as a 409 instead of a 500.
    throw new ApiError(409, "STATE_TRANSITION_REFUSED", (e as Error).message.replace(/^content_state_events: /, ""), { from: last?.status ?? null, to, actor: actor.type });
  }
  return sequence;
}

export function taxonomyForNewRevisions(db: Db): { id: string; skills: Set<string> } {
  const t = db.prepare("SELECT id FROM taxonomy_versions ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string };
  const skills = new Set((db.prepare("SELECT skill_id FROM skill_revisions WHERE taxonomy_id = ? AND active = 1").all(t.id) as Array<{ skill_id: string }>).map((r) => r.skill_id));
  return { id: t.id, skills };
}

export interface NearDuplicate {
  unitFingerprint: string;
  otherRevisionId: string;
  kind: "near_duplicate" | "same_template_cluster";
  similarity: number | null;
}

/**
 * Global dedupe (spec/04): an exact fingerprint already used by another EXERCISE is an error; the same exercise's
 * earlier revisions may legitimately share units (a corrected revision keeps the sentence seen). Near duplicates
 * (token-trigram Jaccard >= .80) and a shared template cluster for the same target skill are quarantine warnings
 * for the reviewer, never an automatic approval or rejection.
 */
export function checkDuplicates(db: Db, p: { exerciseId: string; templateCluster: string; targetSkill: string; units: readonly PromptUnitFingerprint[] }): { errors: ValidationIssue[]; warnings: ValidationIssue[]; near: NearDuplicate[] } {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const near: NearDuplicate[] = [];
  const exact = db.prepare(
    `SELECT DISTINCT er.id AS revisionId, er.exercise_id AS exerciseId FROM prompt_units u
       JOIN revision_prompt_units rpu ON rpu.unit_id = u.id JOIN exercise_revisions er ON er.id = rpu.revision_id
      WHERE u.fingerprint = ? AND er.exercise_id <> ?`,
  );
  for (const u of p.units) {
    for (const hit of exact.all(u.fingerprint, p.exerciseId) as Array<{ revisionId: string; exerciseId: string }>) {
      errors.push({ code: "DUPLICATE_SENTENCE", path: `/units/${u.role}/${u.ordinal}`, message: `sentence already used by exercise ${hit.exerciseId} (revision ${hit.revisionId})` });
    }
  }
  // near duplicates against every stored unit of other exercises
  const mine = p.units.map((u) => ({ u, g: trigrams(u.text) }));
  if (mine.length > 0) {
    const others = db.prepare(
      `SELECT u.fingerprint, u.canonical_text AS text, MIN(er.id) AS revisionId FROM prompt_units u
         JOIN revision_prompt_units rpu ON rpu.unit_id = u.id JOIN exercise_revisions er ON er.id = rpu.revision_id
        WHERE er.exercise_id <> ? GROUP BY u.id`,
    ).all(p.exerciseId) as Array<{ fingerprint: string; text: string; revisionId: string }>;
    const seen = new Set<string>();
    for (const o of others) {
      const og = trigrams(o.text);
      for (const m of mine) {
        if (m.u.fingerprint === o.fingerprint) continue;
        const sim = jaccard(m.g, og);
        const key = `${m.u.fingerprint}|${o.revisionId}`;
        if (sim >= NEAR_DUPLICATE_THRESHOLD && !seen.has(key)) {
          seen.add(key);
          near.push({ unitFingerprint: m.u.fingerprint, otherRevisionId: o.revisionId, kind: "near_duplicate", similarity: sim });
          warnings.push({ code: "NEAR_DUPLICATE", path: `/units/${m.u.role}/${m.u.ordinal}`, message: `trigram Jaccard ${sim.toFixed(2)} with revision ${o.revisionId}: quarantined for the reviewer` });
        }
      }
    }
  }
  const sameCluster = db.prepare(
    `SELECT DISTINCT er.id AS revisionId FROM exercise_revisions er JOIN exercise_skills es ON es.revision_id = er.id AND es.role = 'target'
       JOIN skill_revisions sr ON sr.id = es.skill_revision_id
      WHERE er.template_cluster = ? AND sr.skill_id = ? AND er.exercise_id <> ?`,
  ).all(p.templateCluster, p.targetSkill, p.exerciseId) as Array<{ revisionId: string }>;
  for (const c of sameCluster) {
    near.push({ unitFingerprint: "", otherRevisionId: c.revisionId, kind: "same_template_cluster", similarity: null });
    warnings.push({ code: "SAME_TEMPLATE_CLUSTER", path: "/template_cluster", message: `same delexicalised template cluster and target skill as revision ${c.revisionId}: quarantined for the reviewer` });
  }
  return { errors, warnings, near };
}

export interface RegisteredRevision {
  revisionId: string;
  exerciseId: string;
  revision: number;
  contentHash: string;
  status: ContentStatus;
  warnings: ValidationIssue[];
  units: PromptUnitFingerprint[];
  /** true when the same content hash was already stored (idempotent replay) */
  replayed: boolean;
}

/**
 * Stores a generated/authored exercise as an immutable revision: draft -> validated in one transaction.
 * Invalid or duplicate content is rejected (422) and nothing is stored. The result is never approved or selectable.
 */
export function registerRevision(db: Db, deps: ContentDeps, input: { content: unknown; actor: Actor; reason?: string; sourceBatchId?: string }): RegisteredRevision {
  return db
    .transaction((): RegisteredRevision => {
      const tax = taxonomyForNewRevisions(db);
      const v = validateExercise(input.content, { taxonomySkillIds: tax.skills });
      if (!v.ok) throw new ApiError(422, "CONTENT_INVALID", "Exercise failed validation", { errors: v.errors, warnings: v.warnings });
      const c = input.content as { id: string; revision: number; target_skill: string; additional_skills: string[]; type: string; template_cluster: string; rubric_version: string; dimension: string; difficulty: string; topic: string; context_id: string; bank_role: string; schema_version: string; payload: unknown };
      const hash = v.contentHash!;

      const same = db.prepare("SELECT id, exercise_id AS exerciseId, revision FROM exercise_revisions WHERE content_hash = ?").get(hash) as { id: string; exerciseId: string; revision: number } | undefined;
      if (same) {
        return { revisionId: same.id, exerciseId: same.exerciseId, revision: same.revision, contentHash: hash, status: latestState(db, same.id)!.status, warnings: v.warnings, units: v.units, replayed: true };
      }

      const lastRev = (db.prepare("SELECT COALESCE(MAX(revision), 0) AS n FROM exercise_revisions WHERE exercise_id = ?").get(c.id) as { n: number }).n;
      if (c.revision !== lastRev + 1) {
        throw new ApiError(409, "REVISION_SEQUENCE", `revision must be ${lastRev + 1} for exercise ${c.id} (immutable versions: a correction is a new revision)`, { expected: lastRev + 1, got: c.revision });
      }
      const dups = checkDuplicates(db, { exerciseId: c.id, templateCluster: c.template_cluster, targetSkill: c.target_skill, units: v.units });
      if (dups.errors.length > 0) throw new ApiError(422, "CONTENT_INVALID", "Exercise repeats a sentence that is already in the bank", { errors: dups.errors, warnings: [...v.warnings, ...dups.warnings] });
      const warnings = [...v.warnings, ...dups.warnings];

      const now = deps.now().toISOString();
      if (lastRev === 0) db.prepare("INSERT INTO exercises(id, created_at, source_batch_id) VALUES (?,?,?)").run(c.id, now, input.sourceBatchId ?? null);
      const revisionId = deps.newId();
      db.prepare(
        `INSERT INTO exercise_revisions(id, exercise_id, revision, schema_version, type, content_json, content_hash, rubric_version, taxonomy_id,
                                        dimension, difficulty, topic, context_id, template_cluster, bank_role, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(revisionId, c.id, c.revision, c.schema_version, c.type, JSON.stringify(input.content), hash, c.rubric_version, tax.id, c.dimension, c.difficulty, c.topic, c.context_id, c.template_cluster, c.bank_role, now);

      const skillRev = db.prepare("SELECT id FROM skill_revisions WHERE skill_id = ? AND taxonomy_id = ?");
      const linkSkill = db.prepare("INSERT INTO exercise_skills(revision_id, skill_revision_id, role) VALUES (?,?,?)");
      linkSkill.run(revisionId, (skillRev.get(c.target_skill, tax.id) as { id: string }).id, "target");
      for (const s of c.additional_skills) linkSkill.run(revisionId, (skillRev.get(s, tax.id) as { id: string }).id, "additional");

      const upsert = db.prepare("INSERT OR IGNORE INTO prompt_units(id, canonical_text, fingerprint, normalizer_version, cluster_id) VALUES (?,?,?,?,?)");
      const unitId = db.prepare("SELECT id FROM prompt_units WHERE fingerprint = ?");
      const link = db.prepare("INSERT INTO revision_prompt_units(revision_id, unit_id, role, ordinal) VALUES (?,?,?,?)");
      for (const u of v.units) {
        upsert.run(deps.newId(), u.text, u.fingerprint, NORMALIZER_VERSION, c.template_cluster);
        link.run(revisionId, (unitId.get(u.fingerprint) as { id: string }).id, u.role, u.ordinal);
      }

      appendState(db, deps, revisionId, "draft", input.actor, input.reason ?? "registered");
      appendState(db, deps, revisionId, "validated", { type: "code", id: "validator-v1" }, JSON.stringify({ checks: "schema+semantic+dedupe", warnings: warnings.map((w) => w.code) }));
      return { revisionId, exerciseId: c.id, revision: c.revision, contentHash: hash, status: "validated", warnings, units: v.units, replayed: false };
    })
    .immediate();
}

export function submitForReview(db: Db, deps: ContentDeps, revisionId: string, actor: Actor, reason = "ready for review"): void {
  db.transaction(() => {
    if (actor.type === "model") throw new ApiError(403, "ACTOR_NOT_AUTHORISED", "A model cannot move a revision through states");
    appendState(db, deps, revisionId, "pending_review", actor, reason);
  }).immediate();
}

export interface ReviewInput {
  revisionId: string;
  reviewer: string;
  reviewVersion: string;
  /** the hash the reviewer actually read; must equal the revision's immutable hash */
  contentHash: string;
  checklist: ReviewChecklist;
  verdict: "approved" | "flagged" | "rejected";
}

/** Records one individual review of one revision hash. An approved verdict needs a complete, all-true checklist. */
export function submitReview(db: Db, deps: ContentDeps, input: ReviewInput): string {
  const reviewer = ReviewerSchema.safeParse(input.reviewer);
  if (!reviewer.success) throw new ApiError(422, "REVIEWER_INVALID", reviewer.error.issues[0]?.message ?? "invalid reviewer");
  const checklist = ReviewChecklistSchema.safeParse(input.checklist);
  if (!checklist.success) throw new ApiError(422, "CHECKLIST_INVALID", "Checklist must contain every item", checklist.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return db
    .transaction(() => {
      const rev = revisionRow(db, input.revisionId);
      if (rev.contentHash !== input.contentHash) throw new ApiError(409, "HASH_MISMATCH", "The reviewed hash is not the revision's content hash", { expected: rev.contentHash });
      const state = latestState(db, input.revisionId)?.status;
      if (state !== "pending_review" && state !== "flagged") {
        throw new ApiError(409, "REVIEW_STATE", `A revision can be reviewed only in pending_review or flagged (now ${state ?? "none"})`);
      }
      if (input.verdict === "approved") {
        for (const k of REVIEW_CHECKLIST_KEYS) {
          const val = checklist.data[k];
          const ok = val === true || (val === "n/a" && NA_ALLOWED_KEYS.includes(k));
          if (!ok) throw new ApiError(422, "CHECKLIST_INCOMPLETE", `An approval needs "${k}" to be confirmed`, { item: k });
        }
      }
      const id = deps.newId();
      db.prepare("INSERT INTO content_reviews(id, revision_id, reviewer, review_version, content_hash, at_sequence, checklist_json, verdict, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
        id,
        input.revisionId,
        reviewer.data,
        input.reviewVersion,
        input.contentHash,
        latestState(db, input.revisionId)!.sequence,
        canonicalJson(checklist.data),
        input.verdict,
        deps.now().toISOString(),
      );
      // a review that resolves an open report closes it (the only report update allowed)
      if (input.verdict === "approved") {
        db.prepare("UPDATE exercise_reports SET resolved_by_review_id = ? WHERE revision_id = ? AND resolved_by_review_id IS NULL").run(id, input.revisionId);
      }
      return id;
    })
    .immediate();
}

/** pending_review|flagged -> approved. Only a user/agent whose identity matches the reviewer of the latest approved review. */
export function approveRevision(db: Db, deps: ContentDeps, input: { revisionId: string; actor: Actor; reason?: string }): void {
  db.transaction(() => {
    const prefix = REVIEWER_PREFIX[input.actor.type];
    if (!prefix) throw new ApiError(403, "ACTOR_NOT_AUTHORISED", `Only a user or an agent can approve (got ${input.actor.type})`);
    const rev = revisionRow(db, input.revisionId);
    const review = db.prepare("SELECT id, reviewer FROM content_reviews WHERE revision_id = ? AND verdict = 'approved' AND content_hash = ? ORDER BY rowid DESC LIMIT 1").get(input.revisionId, rev.contentHash) as { id: string; reviewer: string } | undefined;
    if (!review) throw new ApiError(409, "NO_MATCHING_REVIEW", "No approved review with this revision's content hash");
    if (!review.reviewer.startsWith(prefix)) throw new ApiError(409, "REVIEWER_ACTOR_MISMATCH", "An agent review cannot be recorded as a human approval (or the reverse)");
    appendState(db, deps, input.revisionId, "approved", input.actor, input.reason ?? `approved by review ${review.id}`);
  }).immediate();
}

export function rejectRevision(db: Db, deps: ContentDeps, input: { revisionId: string; actor: Actor; reason: string }): void {
  db.transaction(() => appendState(db, deps, input.revisionId, "rejected", input.actor, input.reason)).immediate();
}

export function flagRevision(db: Db, deps: ContentDeps, input: { revisionId: string; actor: Actor; reason: string }): void {
  db.transaction(() => appendState(db, deps, input.revisionId, "flagged", input.actor, input.reason)).immediate();
}

export interface ReportInput {
  exerciseId: string;
  revisionId: string;
  sessionId?: string;
  reason: string;
}

/**
 * "Report incorrect exercise": records the report and, if the revision was approved, flags it at once so it can no longer
 * be selected. Already-shown history is untouched; a later review decides re-approval or a new revision.
 */
export function reportExercise(db: Db, deps: ContentDeps, input: ReportInput): { reportId: string; state: ContentStatus; eligibilityRevoked: boolean } {
  return db
    .transaction(() => {
      const rev = revisionRow(db, input.revisionId);
      if (rev.exerciseId !== input.exerciseId) throw new ApiError(404, "REVISION_NOT_FOUND", "Revision does not belong to this exercise");
      if (input.sessionId && !db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(input.sessionId)) throw new ApiError(404, "SESSION_NOT_FOUND", "Unknown session");
      const reportId = deps.newId();
      db.prepare("INSERT INTO exercise_reports(id, revision_id, session_id, reason, created_at) VALUES (?,?,?,?,?)").run(reportId, input.revisionId, input.sessionId ?? null, input.reason, deps.now().toISOString());
      const before = latestState(db, input.revisionId)!.status;
      let revoked = false;
      if (before !== "flagged" && before !== "rejected") {
        appendState(db, deps, input.revisionId, "flagged", { type: "code", id: "user-report" }, `reported: ${input.reason}`.slice(0, 500));
        revoked = true;
      }
      return { reportId, state: latestState(db, input.revisionId)!.status, eligibilityRevoked: revoked || before === "flagged" };
    })
    .immediate();
}

export interface ReleaseResult {
  releaseId: string;
  manifestHash: string;
  items: Array<{ revisionId: string; contentHash: string; reviewId: string }>;
  replayed: boolean;
}

/**
 * Atomic publish of an explicitly named set of approved revisions (spec/05 "Release transaction"): every item must be
 * approved NOW with an approved review of its exact hash, still pass validation and global dedupe (also against the
 * other items), otherwise nothing is published. Partial release never claims the whole batch.
 */
export function planRelease(db: Db, revisionIds: string[]): { items: ReleaseResult["items"]; manifestHash: string } {
  if (revisionIds.length === 0 || new Set(revisionIds).size !== revisionIds.length) throw new ApiError(422, "RELEASE_ITEMS_INVALID", "A release needs a non-empty list of distinct revision IDs");
  return db
    .transaction((): { items: ReleaseResult["items"]; manifestHash: string } => {
      const tax = taxonomyForNewRevisions(db);
      const items: ReleaseResult["items"] = [];
      const problems: ValidationIssue[] = [];
      const claimed = new Map<string, string>(); // fingerprint -> revision in this release
      for (const revisionId of [...revisionIds].sort()) {
        const rev = revisionRow(db, revisionId);
        const state = latestState(db, revisionId)?.status;
        if (state !== "approved") {
          problems.push({ code: "NOT_APPROVED", path: revisionId, message: `latest state is ${state ?? "none"}` });
          continue;
        }
        const review = db.prepare("SELECT id FROM content_reviews WHERE revision_id = ? AND verdict = 'approved' AND content_hash = ? ORDER BY rowid DESC LIMIT 1").get(revisionId, rev.contentHash) as { id: string } | undefined;
        if (!review) {
          problems.push({ code: "NO_MATCHING_REVIEW", path: revisionId, message: "no approved review with the current content hash" });
          continue;
        }
        const v = validateExercise(JSON.parse(rev.contentJson), { taxonomySkillIds: tax.skills });
        if (!v.ok) {
          problems.push(...v.errors.map((e) => ({ ...e, path: `${revisionId}${e.path}` })));
          continue;
        }
        // other exercises' units already in the bank are checked from the stored links; units of THIS release against each other:
        const stored = db.prepare("SELECT u.fingerprint FROM revision_prompt_units rpu JOIN prompt_units u ON u.id = rpu.unit_id WHERE rpu.revision_id = ?").all(revisionId) as Array<{ fingerprint: string }>;
        for (const { fingerprint } of stored) {
          const holder = claimed.get(fingerprint);
          const otherExercise = holder ? revisionRow(db, holder).exerciseId : null;
          if (holder && otherExercise !== rev.exerciseId) problems.push({ code: "DUPLICATE_SENTENCE", path: revisionId, message: `shares a sentence with ${holder} in the same release` });
          claimed.set(fingerprint, revisionId);
        }
        const released = db.prepare(
          `SELECT DISTINCT ri.revision_id AS revisionId FROM release_items ri JOIN revision_prompt_units rpu ON rpu.revision_id = ri.revision_id
             JOIN prompt_units u ON u.id = rpu.unit_id JOIN exercise_revisions er ON er.id = ri.revision_id
            WHERE u.fingerprint IN (SELECT u2.fingerprint FROM revision_prompt_units r2 JOIN prompt_units u2 ON u2.id = r2.unit_id WHERE r2.revision_id = ?) AND er.exercise_id <> ?`,
        ).all(revisionId, rev.exerciseId) as Array<{ revisionId: string }>;
        for (const r of released) problems.push({ code: "DUPLICATE_SENTENCE", path: revisionId, message: `shares a sentence with already released revision ${r.revisionId}` });
        items.push({ revisionId, contentHash: rev.contentHash, reviewId: review.id });
      }
      if (problems.length > 0) throw new ApiError(422, "RELEASE_REFUSED", "Release refused; nothing was published", { problems });

      return { items, manifestHash: sha256(canonicalJson(items.map((i) => [i.revisionId, i.contentHash, i.reviewId]))) };
    })
    .deferred();
}

export function publishRelease(db: Db, deps: ContentDeps, input: { revisionIds: string[]; reviewer: string; expectedManifestHash?: string }): ReleaseResult {
  const reviewer = ReviewerSchema.safeParse(input.reviewer);
  if (!reviewer.success) throw new ApiError(422, "REVIEWER_INVALID", reviewer.error.issues[0]?.message ?? "invalid reviewer");
  return db
    .transaction((): ReleaseResult => {
      const { items, manifestHash } = planRelease(db, input.revisionIds);
      if (input.expectedManifestHash !== undefined && input.expectedManifestHash !== manifestHash) {
        throw new ApiError(409, "MANIFEST_MISMATCH", "The manifest hash the reviewer saw is not the current one (content, review or state changed); nothing was published", { current: manifestHash });
      }
      const existing = db.prepare("SELECT id FROM releases WHERE manifest_hash = ?").get(manifestHash) as { id: string } | undefined;
      if (existing) return { releaseId: existing.id, manifestHash, items, replayed: true };
      const releaseId = deps.newId();
      db.prepare("INSERT INTO releases(id, manifest_hash, reviewer, created_at) VALUES (?,?,?,?)").run(releaseId, manifestHash, reviewer.data, deps.now().toISOString());
      const ins = db.prepare("INSERT INTO release_items(release_id, revision_id, review_id) VALUES (?,?,?)");
      for (const i of items) ins.run(releaseId, i.revisionId, i.reviewId);
      recordBankEncountersForRevisions(db, deps, items.map((i) => i.revisionId)); // saved words are counted against the newly released content
      return { releaseId, manifestHash, items, replayed: false };
    })
    .immediate();
}
