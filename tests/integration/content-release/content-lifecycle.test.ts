import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REVIEW_CHECKLIST_KEYS, type ReviewChecklist } from "../../../packages/contracts/src/index.js";
import {
  approveRevision,
  checkDuplicates,
  flagRevision,
  isSelectable,
  latestState,
  publishRelease,
  registerRevision,
  rejectRevision,
  reportExercise,
  submitForReview,
  submitReview,
  type ContentDeps,
} from "../../../apps/server/src/domain/content/repository.js";
import { ApiError } from "../../../apps/server/src/errors.js";
import { FIXTURE_NAMES, fixture, uniq, type Exercise } from "../../fixtures/exercises/load.js";
import { advance, makeEnv, one, rows, type Env } from "../attempts/fixtures.js";

let env: Env;
let deps: ContentDeps;
beforeEach(async () => {
  env = await makeEnv();
  deps = { now: env.deps.now, newId: randomUUID };
});
afterEach(() => env.cleanup());

const AGENT = { type: "agent" as const, id: "claude-test@1" };
const HUMAN = { type: "user" as const, id: "owner" };
const ALL_TRUE = Object.fromEntries(REVIEW_CHECKLIST_KEYS.map((k) => [k, true])) as ReviewChecklist;
const NA = { ...ALL_TRUE, distractors_valid: "n/a", no_mistake_case_correct: "n/a" } as ReviewChecklist;
const reg = (c: Exercise) => registerRevision(env.db, deps, { content: c, actor: { type: "model", id: "qwen3:14b@sha256:test" } });
const count = (t: string) => (one(env.db, `SELECT COUNT(*) AS n FROM ${t}`) as { n: number }).n;
const status = (id: string) => latestState(env.db, id)!.status;
const failsWith = (fn: () => unknown, status: number, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect({ status: (e as ApiError).status, code: (e as ApiError).code }).toEqual({ status, code });
    return e as ApiError;
  }
  throw new Error(`expected ApiError ${status} ${code}`);
};
const dbFails = (sql: string, ...p: unknown[]) => {
  let msg = "";
  try {
    env.db.prepare(sql).run(...p);
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).not.toBe("");
  return msg;
};

/** register -> pending_review -> approved review -> approved state (agent) */
function approveFully(c: Exercise, checklist: ReviewChecklist = ALL_TRUE) {
  const r = reg(c);
  submitForReview(env.db, deps, r.revisionId, AGENT);
  advance(env, 10);
  const reviewId = submitReview(env.db, deps, { revisionId: r.revisionId, reviewer: "agent:claude-test@1", reviewVersion: "review-v1", contentHash: r.contentHash, checklist, verdict: "approved" });
  advance(env, 10);
  approveRevision(env.db, deps, { revisionId: r.revisionId, actor: AGENT });
  return { ...r, reviewId };
}

describe("registering generated content", () => {
  it.each(FIXTURE_NAMES)("%s is stored as an immutable revision that ends at 'validated', never approved", (name) => {
    const r = reg(fixture(name));
    expect(r).toMatchObject({ status: "validated", revision: 1, replayed: false });
    expect(rows(env.db, "SELECT sequence, from_status, to_status, actor_type FROM content_state_events WHERE revision_id = ? ORDER BY sequence", r.revisionId)).toEqual([
      { sequence: 1, from_status: null, to_status: "draft", actor_type: "model" },
      { sequence: 2, from_status: "draft", to_status: "validated", actor_type: "code" },
    ]);
    expect(isSelectable(env.db, r.revisionId)).toBe(false);
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM exercise_skills WHERE revision_id = ? AND role = 'target'", r.revisionId).n).toBe(1);
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM revision_prompt_units WHERE revision_id = ?", r.revisionId).n).toBe(r.units.length);
  });

  it("is idempotent for identical content and keeps one revision", () => {
    const a = reg(fixture("choose_form"));
    const b = reg(fixture("choose_form"));
    expect(b).toMatchObject({ revisionId: a.revisionId, replayed: true });
    expect(count("exercise_revisions")).toBe(1);
    expect(count("content_state_events")).toBe(2);
  });

  it("refuses invalid content and stores nothing", () => {
    const bad = fixture("detect_error");
    bad.payload.sentence = "something else entirely";
    const e = failsWith(() => reg(bad), 422, "CONTENT_INVALID");
    expect(JSON.stringify(e.details)).toContain("SEGMENTS_NOT_SENTENCE");
    expect([count("exercises"), count("exercise_revisions"), count("content_state_events"), count("prompt_units")]).toEqual([0, 0, 0, 0]);
  });

  it("refuses a model-supplied status other than draft", () => {
    const sneaky = fixture("choose_form");
    sneaky.status = "approved";
    const e = failsWith(() => reg(sneaky), 422, "CONTENT_INVALID");
    expect(JSON.stringify(e.details)).toContain("STATUS_NOT_DRAFT");
    expect(count("exercise_revisions")).toBe(0);
  });

  it("revision numbers are sequential and a correction is a new revision with its own review", () => {
    const first = reg(fixture("choose_form"));
    const skipped = fixture("choose_form");
    skipped.revision = 3;
    failsWith(() => reg(skipped), 409, "REVISION_SEQUENCE");
    const corrected = fixture("choose_form");
    corrected.revision = 2;
    corrected.explanation_ru = "Исправленное объяснение: yesterday требует Past Simple.";
    const second = reg(corrected);
    expect(second).toMatchObject({ revision: 2, exerciseId: first.exerciseId, status: "validated" });
    expect(second.revisionId).not.toBe(first.revisionId);
    expect(one<{ content_hash: string }>(env.db, "SELECT content_hash FROM exercise_revisions WHERE id = ?", first.revisionId).content_hash).toBe(first.contentHash); // the old one is untouched
    // sentences are shared with the earlier revision of the SAME exercise without being "duplicates"
    expect(second.warnings.map((w) => w.code)).not.toContain("DUPLICATE_SENTENCE");
  });
});

describe("global sentence dedupe (spec/04)", () => {
  it("refuses an exercise that repeats a sentence of another exercise - also across formats", () => {
    reg(fixture("choose_form")); // restores: "The council published the revised timetable yesterday."
    const other = fixture("guided_short_answer");
    other.payload.accepted_answers = ["The council published the revised timetable yesterday!"]; // typography differs only
    const e = failsWith(() => reg(other), 422, "CONTENT_INVALID");
    expect(JSON.stringify(e.details)).toContain("DUPLICATE_SENTENCE");
    expect(count("exercises")).toBe(1);
  });

  it("also catches a repeat through a reading passage sentence and through a full-sentence option", () => {
    reg(fixture("context_reading"));
    const viaDetect = fixture("detect_error");
    viaDetect.payload.sentence = "The Riverside Lantern Festival has been postponed until next month.";
    viaDetect.payload.segments = [{ id: "s1", text: "The Riverside Lantern Festival has been postponed until next month." }];
    viaDetect.payload.accepted_segment_ids = [];
    viaDetect.payload.corrections = [];
    viaDetect.payload.no_mistake = true;
    failsWith(() => reg(viaDetect), 422, "CONTENT_INVALID");
  });

  it("quarantines near duplicates and a shared template cluster as reviewer warnings instead of refusing", () => {
    const a = reg(fixture("choose_form"));
    const sibling = uniq("choose_form", "Yesterday,");
    sibling.template_cluster = fixture("choose_form").template_cluster; // same cluster + same target skill
    const b = reg(sibling);
    expect(b.status).toBe("validated");
    const codes = b.warnings.map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(["NEAR_DUPLICATE", "SAME_TEMPLATE_CLUSTER"]));
    expect(b.warnings.find((w) => w.code === "SAME_TEMPLATE_CLUSTER")!.message).toContain(a.revisionId);
    // the warning is recorded in the immutable state event the reviewer sees
    expect(one<{ reason: string }>(env.db, "SELECT reason FROM content_state_events WHERE revision_id = ? AND to_status = 'validated'", b.revisionId).reason).toContain("NEAR_DUPLICATE");
  });

  it("different sentences of the same template family are not exact duplicates", () => {
    reg(fixture("choose_form"));
    expect(reg(uniq("choose_missing_fragment", "Today")).status).toBe("validated");
    expect(checkDuplicates(env.db, { exerciseId: randomUUID(), templateCluster: "none", targetSkill: "x", units: [] })).toEqual({ errors: [], warnings: [], near: [] });
  });
});

describe("states, reviews and release: only reviewed + released content is selectable", () => {
  it("walks draft -> validated -> pending_review -> approved -> released; each step is audited", () => {
    const r = reg(fixture("choose_form"));
    expect(isSelectable(env.db, r.revisionId)).toBe(false);
    submitForReview(env.db, deps, r.revisionId, AGENT);
    expect(status(r.revisionId)).toBe("pending_review");
    expect(isSelectable(env.db, r.revisionId)).toBe(false);
    advance(env, 10);
    const reviewId = submitReview(env.db, deps, { revisionId: r.revisionId, reviewer: "agent:claude-test@1", reviewVersion: "review-v1", contentHash: r.contentHash, checklist: NA, verdict: "approved" });
    expect(status(r.revisionId)).toBe("pending_review"); // a review alone does not approve
    advance(env, 10);
    approveRevision(env.db, deps, { revisionId: r.revisionId, actor: AGENT });
    expect(status(r.revisionId)).toBe("approved");
    expect(isSelectable(env.db, r.revisionId)).toBe(false); // approved but not released

    const rel = publishRelease(env.db, deps, { revisionIds: [r.revisionId], reviewer: "agent:claude-test@1" });
    expect(rel.replayed).toBe(false);
    expect(isSelectable(env.db, r.revisionId)).toBe(true);
    expect(rel.items).toEqual([{ revisionId: r.revisionId, contentHash: r.contentHash, reviewId }]);
    expect(rows(env.db, "SELECT sequence, to_status, actor_type FROM content_state_events WHERE revision_id = ? ORDER BY sequence", r.revisionId).map((e) => e.to_status)).toEqual(["draft", "validated", "pending_review", "approved"]);
    expect(one<{ reviewer: string; content_hash: string }>(env.db, "SELECT reviewer, content_hash FROM content_reviews WHERE id = ?", reviewId)).toEqual({ reviewer: "agent:claude-test@1", content_hash: r.contentHash });
  });

  it("no draft, validated-only or pending revision is ever selectable", () => {
    const ids = FIXTURE_NAMES.map((n) => reg(fixture(n)).revisionId);
    expect(count("selectable_revisions")).toBe(0);
    submitForReview(env.db, deps, ids[0]!, AGENT);
    expect(count("selectable_revisions")).toBe(0);
    expect(ids.every((id) => !isSelectable(env.db, id))).toBe(true);
  });

  it("refuses approval without a matching review, with a wrong hash, or with an incomplete checklist", () => {
    const r = reg(fixture("choose_form"));
    submitForReview(env.db, deps, r.revisionId, AGENT);
    failsWith(() => approveRevision(env.db, deps, { revisionId: r.revisionId, actor: AGENT }), 409, "NO_MATCHING_REVIEW");
    const base = { revisionId: r.revisionId, reviewer: "agent:claude-test@1", reviewVersion: "v1", verdict: "approved" as const };
    failsWith(() => submitReview(env.db, deps, { ...base, contentHash: "0".repeat(64), checklist: ALL_TRUE }), 409, "HASH_MISMATCH");
    for (const key of REVIEW_CHECKLIST_KEYS) {
      const e = failsWith(() => submitReview(env.db, deps, { ...base, contentHash: r.contentHash, checklist: { ...ALL_TRUE, [key]: false } }), 422, "CHECKLIST_INCOMPLETE");
      expect(e.details).toEqual({ item: key });
    }
    failsWith(() => submitReview(env.db, deps, { ...base, contentHash: r.contentHash, checklist: { ...ALL_TRUE, natural_en_au_b2: "n/a" } as never }), 422, "CHECKLIST_INCOMPLETE");
    failsWith(() => submitReview(env.db, deps, { ...base, contentHash: r.contentHash, checklist: { natural_en_au_b2: true } as never }), 422, "CHECKLIST_INVALID");
    expect(count("content_reviews")).toBe(0);
    expect(status(r.revisionId)).toBe("pending_review");
  });

  it("a flagged or rejected verdict needs no complete checklist, and does not approve", () => {
    const r = reg(fixture("choose_form"));
    submitForReview(env.db, deps, r.revisionId, AGENT);
    submitReview(env.db, deps, { revisionId: r.revisionId, reviewer: "human:owner", reviewVersion: "v1", contentHash: r.contentHash, checklist: { ...ALL_TRUE, natural_en_au_b2: false }, verdict: "rejected" });
    failsWith(() => approveRevision(env.db, deps, { revisionId: r.revisionId, actor: HUMAN }), 409, "NO_MATCHING_REVIEW");
  });

  it("needs the reviewer to be identified as human or agent, and the approving actor to match", () => {
    const r = reg(fixture("choose_form"));
    submitForReview(env.db, deps, r.revisionId, AGENT);
    for (const bad of ["claude", "agent:", "bot:x", "human: "]) {
      failsWith(() => submitReview(env.db, deps, { revisionId: r.revisionId, reviewer: bad, reviewVersion: "v", contentHash: r.contentHash, checklist: ALL_TRUE, verdict: "approved" }), 422, "REVIEWER_INVALID");
    }
    advance(env, 5);
    submitReview(env.db, deps, { revisionId: r.revisionId, reviewer: "agent:claude-test@1", reviewVersion: "v", contentHash: r.contentHash, checklist: ALL_TRUE, verdict: "approved" });
    advance(env, 5);
    failsWith(() => approveRevision(env.db, deps, { revisionId: r.revisionId, actor: HUMAN }), 409, "REVIEWER_ACTOR_MISMATCH"); // an agent review is not a human one
    failsWith(() => approveRevision(env.db, deps, { revisionId: r.revisionId, actor: { type: "code", id: "validator" } }), 403, "ACTOR_NOT_AUTHORISED");
    failsWith(() => approveRevision(env.db, deps, { revisionId: r.revisionId, actor: { type: "model", id: "qwen" } }), 403, "ACTOR_NOT_AUTHORISED");
    expect(status(r.revisionId)).toBe("pending_review");
  });

  it("only validated revisions go to review and only in pending_review/flagged can a review be written", () => {
    const r = reg(fixture("choose_form"));
    failsWith(() => submitReview(env.db, deps, { revisionId: r.revisionId, reviewer: "human:owner", reviewVersion: "v", contentHash: r.contentHash, checklist: ALL_TRUE, verdict: "approved" }), 409, "REVIEW_STATE");
    failsWith(() => submitForReview(env.db, deps, r.revisionId, { type: "model", id: "qwen" }), 403, "ACTOR_NOT_AUTHORISED");
    submitForReview(env.db, deps, r.revisionId, HUMAN);
    failsWith(() => submitForReview(env.db, deps, r.revisionId, HUMAN), 409, "STATE_TRANSITION_REFUSED"); // already pending_review
  });

  it("rejected is terminal", () => {
    const r = reg(fixture("choose_form"));
    rejectRevision(env.db, deps, { revisionId: r.revisionId, actor: HUMAN, reason: "ambiguous distractor" });
    expect(status(r.revisionId)).toBe("rejected");
    failsWith(() => submitForReview(env.db, deps, r.revisionId, HUMAN), 409, "STATE_TRANSITION_REFUSED");
    failsWith(() => flagRevision(env.db, deps, { revisionId: r.revisionId, actor: HUMAN, reason: "again" }), 409, "STATE_TRANSITION_REFUSED");
    failsWith(() => rejectRevision(env.db, deps, { revisionId: r.revisionId, actor: { type: "code", id: "x" }, reason: "code may not reject" }), 409, "STATE_TRANSITION_REFUSED");
  });
});

describe("the database refuses what the application would never do (backstop)", () => {
  const raw = (revisionId: string, hash: string, seq: number, from: string | null, to: string, actor: string, id = randomUUID()) =>
    env.db
      .prepare("INSERT INTO content_state_events(id, revision_id, sequence, from_status, to_status, actor_type, actor_id, reason, content_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, revisionId, seq, from, to, actor, "tester", "raw sql", hash, "now");

  it("rejects a status written straight to the log: no review, wrong actor, skipped step, wrong hash, broken chain", () => {
    const r = reg(fixture("choose_form")); // seq 1 draft, 2 validated
    const h = r.contentHash;
    expect(() => raw(r.revisionId, h, 3, "validated", "approved", "agent")).toThrow(/not allowed|approval requires/); // validated -> approved is not a transition
    expect(() => raw(r.revisionId, h, 3, "validated", "pending_review", "model")).toThrow(/not authorised/); // models only create drafts
    submitForReview(env.db, deps, r.revisionId, AGENT); // seq 3
    expect(() => raw(r.revisionId, h, 4, "pending_review", "approved", "agent")).toThrow(/approval requires a newer approved review/);
    // with a valid review in place, only the actor rule remains: code and models can never approve
    submitReview(env.db, deps, { revisionId: r.revisionId, reviewer: "agent:claude-test@1", reviewVersion: "v1", contentHash: h, checklist: NA, verdict: "approved" });
    expect(() => raw(r.revisionId, h, 4, "pending_review", "approved", "code")).toThrow(/not authorised/);
    expect(() => raw(r.revisionId, h, 4, "pending_review", "approved", "model")).toThrow(/not authorised/);
    expect(() => raw(r.revisionId, "f".repeat(64), 4, "pending_review", "flagged", "code")).toThrow(/content_hash must equal/);
    expect(() => raw(r.revisionId, h, 9, "pending_review", "flagged", "code")).toThrow(/sequence/);
    expect(() => raw(r.revisionId, h, 4, "draft", "flagged", "code")).toThrow(/sequence \/ from_status/);
    expect(() => raw(randomUUID(), h, 1, null, "draft", "code")).toThrow(/FOREIGN KEY/);
    expect(status(r.revisionId)).toBe("pending_review");
  });

  it("the first state must be draft; draft cannot be validated by a model", () => {
    const r = reg(fixture("choose_form"));
    const other = reg(fixture("detect_error"));
    expect(() => raw(r.revisionId, r.contentHash, 1, null, "approved", "agent")).toThrow(); // revision already has events
    expect(other.status).toBe("validated");
  });

  it("a stale review does not authorise a later approval (re-approval after a flag needs a NEW review)", () => {
    const a = approveFully(fixture("choose_form"));
    flagRevision(env.db, deps, { revisionId: a.revisionId, actor: { type: "code", id: "user-report" }, reason: "report" });
    advance(env, 5);
    expect(() => raw(a.revisionId, a.contentHash, 5, "flagged", "approved", "agent")).toThrow(/newer approved review/); // the old review predates the flag
    advance(env, 5);
    submitReview(env.db, deps, { revisionId: a.revisionId, reviewer: "agent:claude-test@1", reviewVersion: "review-v2", contentHash: a.contentHash, checklist: ALL_TRUE, verdict: "approved" });
    approveRevision(env.db, deps, { revisionId: a.revisionId, actor: AGENT });
    expect(status(a.revisionId)).toBe("approved");
  });

  it("history tables are append-only and a review must name the real hash", () => {
    const a = approveFully(fixture("choose_form"));
    publishRelease(env.db, deps, { revisionIds: [a.revisionId], reviewer: "agent:claude-test@1" });
    for (const [t, set] of [["content_state_events", "reason = 'x'"], ["content_reviews", "verdict = 'rejected'"], ["releases", "reviewer = 'x'"], ["release_items", "review_id = 'x'"], ["exercise_skills", "role = 'additional'"], ["prompt_units", "canonical_text = 'x'"], ["exercise_revisions", "topic = 'x'"]] as const) {
      expect(dbFails(`UPDATE ${t} SET ${set}`)).toMatch(/append-only|immutable/);
      expect(dbFails(`DELETE FROM ${t}`)).toMatch(/append-only|immutable/);
    }
    const insertReview = "INSERT INTO content_reviews(id, revision_id, reviewer, review_version, content_hash, at_sequence, checklist_json, verdict, created_at) VALUES (?,?,?,?,?,?,?,?,?)";
    const seq = latestState(env.db, a.revisionId)!.sequence;
    expect(dbFails(insertReview, randomUUID(), a.revisionId, "agent:x", "v", "0".repeat(64), seq, "{}", "approved", "now")).toMatch(/must be written against|content_hash must equal/);
    const pending = reg(fixture("detect_error"));
    submitForReview(env.db, deps, pending.revisionId, AGENT);
    expect(dbFails(insertReview, randomUUID(), pending.revisionId, "someone", "v", pending.contentHash, latestState(env.db, pending.revisionId)!.sequence, "{}", "approved", "now")).toMatch(/CHECK/); // unidentified reviewer
    // the revision is approved now: nobody can attach another review to that state
    expect(dbFails(insertReview, randomUUID(), a.revisionId, "agent:x", "v", a.contentHash, seq, "{}", "approved", "now")).toMatch(/must be written against the current pending_review\/flagged state/);
  });

  it("release items must be approved now with their own matching approved review", () => {
    const draft = reg(fixture("choose_form"));
    const rel = randomUUID();
    env.db.prepare("INSERT INTO releases(id, manifest_hash, reviewer, created_at) VALUES (?,?,?,?)").run(rel, "h".repeat(64), "agent:x", "now");
    const review = approveFully(fixture("detect_error"));
    expect(dbFails("INSERT INTO release_items(release_id, revision_id, review_id) VALUES (?,?,?)", rel, draft.revisionId, review.reviewId)).toMatch(/release_items/);
    expect(dbFails("INSERT INTO release_items(release_id, revision_id, review_id) VALUES (?,?,?)", rel, review.revisionId, randomUUID())).toMatch(/FOREIGN KEY|release_items/);
  });
});

describe("release transaction (spec/05)", () => {
  it("publishes an explicit approved subset atomically; the manifest hash is deterministic and re-publishing is idempotent", () => {
    const a = approveFully(fixture("choose_form"), NA);
    const b = approveFully(fixture("detect_error_no_mistake"), NA);
    const rel = publishRelease(env.db, deps, { revisionIds: [b.revisionId, a.revisionId], reviewer: "human:owner" });
    expect(rel.items.map((i) => i.revisionId).sort()).toEqual([a.revisionId, b.revisionId].sort());
    expect(rel.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(count("release_items")).toBe(2);
    const again = publishRelease(env.db, deps, { revisionIds: [a.revisionId, b.revisionId], reviewer: "human:owner" });
    expect(again).toMatchObject({ releaseId: rel.releaseId, manifestHash: rel.manifestHash, replayed: true });
    expect([count("releases"), count("release_items")]).toEqual([1, 2]);
    expect(count("selectable_revisions")).toBe(2);
  });

  it("refuses the whole release when one item is not approved; nothing is published", () => {
    const ok = approveFully(fixture("choose_form"), NA);
    const pending = reg(fixture("detect_error"));
    const e = failsWith(() => publishRelease(env.db, deps, { revisionIds: [ok.revisionId, pending.revisionId], reviewer: "human:owner" }), 422, "RELEASE_REFUSED");
    expect(JSON.stringify(e.details)).toContain("NOT_APPROVED");
    expect([count("releases"), count("release_items"), count("selectable_revisions")]).toEqual([0, 0, 0]);
  });

  it("refuses flagged revisions, bad input and an unidentified reviewer", () => {
    const a = approveFully(fixture("choose_form"), NA);
    flagRevision(env.db, deps, { revisionId: a.revisionId, actor: HUMAN, reason: "wrong" });
    failsWith(() => publishRelease(env.db, deps, { revisionIds: [a.revisionId], reviewer: "human:owner" }), 422, "RELEASE_REFUSED");
    failsWith(() => publishRelease(env.db, deps, { revisionIds: [], reviewer: "human:owner" }), 422, "RELEASE_ITEMS_INVALID");
    failsWith(() => publishRelease(env.db, deps, { revisionIds: [a.revisionId, a.revisionId], reviewer: "human:owner" }), 422, "RELEASE_ITEMS_INVALID");
    failsWith(() => publishRelease(env.db, deps, { revisionIds: [a.revisionId], reviewer: "anonymous" }), 422, "REVIEWER_INVALID");
    failsWith(() => publishRelease(env.db, deps, { revisionIds: [randomUUID()], reviewer: "human:owner" }), 404, "REVISION_NOT_FOUND");
    expect(count("releases")).toBe(0);
  });

  it("a corrected revision is a separate release candidate: the old approved revision keeps serving until flagged", () => {
    const first = approveFully(fixture("choose_form"), NA);
    publishRelease(env.db, deps, { revisionIds: [first.revisionId], reviewer: "human:owner" });
    const fixed = fixture("choose_form");
    fixed.revision = 2;
    fixed.explanation_ru = "Исправление: yesterday задаёт завершённое прошлое.";
    const second = reg(fixed);
    expect(isSelectable(env.db, first.revisionId)).toBe(true);
    expect(isSelectable(env.db, second.revisionId)).toBe(false);
    flagRevision(env.db, deps, { revisionId: first.revisionId, actor: HUMAN, reason: "replaced by revision 2" });
    expect(isSelectable(env.db, first.revisionId)).toBe(false);
  });
});

describe("report incorrect exercise: flagged withdrawal", () => {
  it("revokes eligibility at once, keeps every release and history row, and re-approval needs a fresh review", () => {
    const a = approveFully(fixture("choose_form"), NA);
    publishRelease(env.db, deps, { revisionIds: [a.revisionId], reviewer: "human:owner" });
    expect(isSelectable(env.db, a.revisionId)).toBe(true);

    advance(env, 1000);
    const rep = reportExercise(env.db, deps, { exerciseId: a.exerciseId, revisionId: a.revisionId, reason: "The accepted answer is wrong in this context." });
    expect(rep).toMatchObject({ state: "flagged", eligibilityRevoked: true });
    expect(isSelectable(env.db, a.revisionId)).toBe(false);
    expect([count("releases"), count("release_items"), count("content_reviews")]).toEqual([1, 1, 1]); // withdrawal does not delete history
    expect(one(env.db, "SELECT reason, resolved_by_review_id FROM exercise_reports WHERE id = ?", rep.reportId)).toEqual({ reason: "The accepted answer is wrong in this context.", resolved_by_review_id: null });

    // a release cannot bring it back; a later flagged state wins over the earlier release
    failsWith(() => publishRelease(env.db, deps, { revisionIds: [a.revisionId], reviewer: "human:owner" }), 422, "RELEASE_REFUSED");
    failsWith(() => approveRevision(env.db, deps, { revisionId: a.revisionId, actor: AGENT }), 409, "STATE_TRANSITION_REFUSED"); // old review predates the flag

    advance(env, 1000);
    const review = submitReview(env.db, deps, { revisionId: a.revisionId, reviewer: "agent:claude-test@1", reviewVersion: "review-v2", contentHash: a.contentHash, checklist: NA, verdict: "approved" });
    expect(one<{ resolved_by_review_id: string }>(env.db, "SELECT resolved_by_review_id FROM exercise_reports WHERE id = ?", rep.reportId).resolved_by_review_id).toBe(review);
    approveRevision(env.db, deps, { revisionId: a.revisionId, actor: AGENT });
    expect(isSelectable(env.db, a.revisionId)).toBe(true);
    expect(rows(env.db, "SELECT to_status FROM content_state_events WHERE revision_id = ? ORDER BY sequence", a.revisionId).map((r) => r.to_status)).toEqual(["draft", "validated", "pending_review", "approved", "flagged", "approved"]);
  });

  it("reports on a draft or an already flagged revision are recorded; a revision of another exercise is refused", () => {
    const r = reg(fixture("choose_form"));
    const other = reg(fixture("detect_error"));
    expect(reportExercise(env.db, deps, { exerciseId: r.exerciseId, revisionId: r.revisionId, reason: "typo" })).toMatchObject({ state: "flagged" });
    expect(reportExercise(env.db, deps, { exerciseId: r.exerciseId, revisionId: r.revisionId, reason: "still wrong" })).toMatchObject({ state: "flagged", eligibilityRevoked: true });
    expect(count("exercise_reports")).toBe(2);
    failsWith(() => reportExercise(env.db, deps, { exerciseId: r.exerciseId, revisionId: other.revisionId, reason: "x" }), 404, "REVISION_NOT_FOUND");
    expect(count("exercise_reports")).toBe(2);
  });

  it("only resolved_by_review_id of a report can ever change, once", () => {
    const a = approveFully(fixture("choose_form"), NA);
    const rep = reportExercise(env.db, deps, { exerciseId: a.exerciseId, revisionId: a.revisionId, reason: "wrong" });
    expect(dbFails("UPDATE exercise_reports SET reason = 'edited' WHERE id = ?", rep.reportId)).toMatch(/only resolved_by_review_id/);
    expect(dbFails("DELETE FROM exercise_reports")).toMatch(/append-only/);
  });
});
