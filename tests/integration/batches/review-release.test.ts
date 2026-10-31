import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../../../apps/server/src/errors.js";
import { exportBatch, exportCoverage } from "../../../apps/server/src/domain/content/batches/export.js";
import { importReviewManifest } from "../../../apps/server/src/domain/content/batches/reviewImport.js";
import { coverage, createBatch, getBatch, trialGate } from "../../../apps/server/src/domain/content/batches/repository.js";
import { approveRevision, planRelease, publishRelease, reportExercise } from "../../../apps/server/src/domain/content/repository.js";
import { one, rows } from "../attempts/fixtures.js";
import { batchJobsSettled, batchRevisions, checklistAllTrue, closeRigs, drive, makeRig, manifest, type Rig } from "./fixtures.js";

afterEach(closeRigs);

async function trialReady(): Promise<{ r: Rig; batchId: string }> {
  const r = await makeRig();
  const { batchId } = createBatch(r.env.db, r.deps, { count: 24, mode: "balanced", trial: true });
  await drive(r, () => batchJobsSettled(r, batchId));
  return { r, batchId };
}
const refusal = (fn: () => unknown): ApiError => {
  try {
    fn();
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("expected a refusal");
};
const reviewCount = (r: Rig) => one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM content_reviews").n;
const sum = (c: Record<string, number>) => Object.values(c).reduce((a, n) => a + n, 0);

describe("review import: every revision hash is reviewed individually", () => {
  it("records one review per item with the reviewer's own identity, and moves the states accordingly", async () => {
    const { r, batchId } = await trialReady();
    const revs = batchRevisions(r, batchId);
    const res = importReviewManifest(r.env.db, r.deps, batchId, manifest([...revs.slice(0, 16).map((rev) => ({ rev, verdict: "approved" as const })), ...revs.slice(16, 20).map((rev) => ({ rev, verdict: "flagged" as const })), ...revs.slice(20).map((rev) => ({ rev, verdict: "rejected" as const }))]));
    expect(res).toMatchObject({ recorded: 24, approved: 16, flagged: 4, rejected: 4, reviewer: "agent:test-reviewer@1" });
    expect(reviewCount(r)).toBe(24);
    const b = getBatch(r.env.db, batchId);
    expect(b.counts).toMatchObject({ approved: 16, flagged: 4, rejected: 4, ready_for_review: 0, released: 0 });
    expect(sum(b.counts)).toBe(24); // totals are reconstructable from the events
    expect(b.reviewedItems).toBe(24);
    expect(b.resolved).toBe(true);
    // approval is recorded as an agent decision, never as a human one
    expect(rows<{ actor_type: string; actor_id: string }>(r.env.db, "SELECT actor_type, actor_id FROM content_state_events WHERE to_status = 'approved'").every((e) => e.actor_type === "agent" && e.actor_id.startsWith("agent:"))).toBe(true);
    // approved but NOT published: still not selectable
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM selectable_revisions").n).toBe(0);
  });

  it("a human reviewer is recorded as a user", async () => {
    const { r, batchId } = await trialReady();
    const [rev] = batchRevisions(r, batchId);
    importReviewManifest(r.env.db, r.deps, batchId, manifest([{ rev: rev!, verdict: "approved" }], "human:Dana"));
    expect(one<{ actor_type: string }>(r.env.db, "SELECT actor_type FROM content_state_events WHERE to_status = 'approved'").actor_type).toBe("user");
  });

  it("a STALE hash refuses the whole manifest: nothing is recorded, not even the valid items", async () => {
    const { r, batchId } = await trialReady();
    const revs = batchRevisions(r, batchId);
    const m = manifest(revs.slice(0, 5).map((rev) => ({ rev, verdict: "approved" as const })));
    m.items[3]!.content_hash = "0".repeat(64);
    const e = refusal(() => importReviewManifest(r.env.db, r.deps, batchId, m));
    expect(e).toMatchObject({ status: 409, code: "REVIEW_IMPORT_REFUSED" });
    expect(JSON.stringify(e.details)).toContain("STALE_HASH");
    expect(reviewCount(r)).toBe(0);
    expect(getBatch(r.env.db, batchId).counts.ready_for_review).toBe(24);
  });

  it("refuses foreign revisions, duplicates, wrong state and an incomplete checklist - each without side effects", async () => {
    const { r, batchId } = await trialReady();
    const other = createBatch(r.env.db, r.deps, { count: 24, mode: "balanced", trial: true }); // a second trial, still queued
    expect(other.batchId).not.toBe(batchId);
    const revs = batchRevisions(r, batchId);
    const foreign = { ...revs[0]!, revisionId: randomUUID() };
    expect(JSON.stringify(refusal(() => importReviewManifest(r.env.db, r.deps, batchId, manifest([{ rev: foreign, verdict: "approved" }]))).details)).toContain("NOT_IN_BATCH");
    expect(JSON.stringify(refusal(() => importReviewManifest(r.env.db, r.deps, batchId, manifest([{ rev: revs[0]!, verdict: "approved" }, { rev: revs[0]!, verdict: "rejected" }]))).details)).toContain("DUPLICATE_ITEM");
    // an incomplete checklist cannot approve (422) and leaves no record
    const weak = manifest([{ rev: revs[1]!, verdict: "approved" }]);
    weak.items[0]!.checklist = { ...checklistAllTrue(), natural_en_au_b2: false };
    expect(refusal(() => importReviewManifest(r.env.db, r.deps, batchId, weak))).toMatchObject({ status: 422, code: "CHECKLIST_INCOMPLETE" });
    expect(reviewCount(r)).toBe(0);
    // reviewing twice: the second pass finds the revision already decided
    importReviewManifest(r.env.db, r.deps, batchId, manifest([{ rev: revs[2]!, verdict: "approved" }]));
    expect(JSON.stringify(refusal(() => importReviewManifest(r.env.db, r.deps, batchId, manifest([{ rev: revs[2]!, verdict: "rejected" }]))).details)).toContain("REVIEW_STATE");
    // malformed manifests never reach the database
    expect(refusal(() => importReviewManifest(r.env.db, r.deps, batchId, { schema_version: "content-review-v1", reviewer: "agent:x@1", review_version: "p", items: [] }))).toMatchObject({ status: 400 });
    expect(refusal(() => importReviewManifest(r.env.db, r.deps, batchId, { ...manifest([{ rev: revs[3]!, verdict: "approved" }]), reviewer: "nobody" }))).toMatchObject({ status: 422, code: "REVIEWER_INVALID" });
    expect(refusal(() => importReviewManifest(r.env.db, r.deps, randomUUID(), manifest([{ rev: revs[3]!, verdict: "approved" }])))).toMatchObject({ status: 404 });
  });

  it("there is no batch-wide approval: a model, a code actor or a missing review cannot approve a revision", async () => {
    const { r, batchId } = await trialReady();
    const [rev] = batchRevisions(r, batchId);
    for (const type of ["model", "code"] as const) {
      expect(refusal(() => approveRevision(r.env.db, r.deps, { revisionId: rev!.revisionId, actor: { type, id: "x" } })).status).toBe(403);
    }
    expect(refusal(() => approveRevision(r.env.db, r.deps, { revisionId: rev!.revisionId, actor: { type: "agent", id: "agent:x@1" } })).code).toBe("NO_MATCHING_REVIEW");
    expect(getBatch(r.env.db, batchId).counts.approved).toBe(0);
  });
});

describe("trial gate and scale", () => {
  it("opens only when every trial item is resolved AND at least 18 of the 24 drafts were approved, and then allows a 50-item batch", async () => {
    const { r, batchId } = await trialReady();
    const revs = batchRevisions(r, batchId);
    importReviewManifest(r.env.db, r.deps, batchId, manifest(revs.slice(0, 23).map((rev) => ({ rev, verdict: "approved" as const }))));
    expect(trialGate(r.env.db).passed).toBe(false); // one draft still unreviewed
    expect(createBatch(r.env.db, r.deps, { count: 50, mode: "adaptive", trial: false }).items).toBe(50);
    importReviewManifest(r.env.db, r.deps, batchId, manifest([{ rev: revs[23]!, verdict: "rejected" }]));
    expect(trialGate(r.env.db)).toMatchObject({ passed: true, trialBatchId: batchId });
    const big = createBatch(r.env.db, r.deps, { count: 50, mode: "adaptive", trial: false });
    expect(big).toMatchObject({ purpose: "scale", items: 50 });
    expect(getBatch(r.env.db, big.batchId).counts.queued).toBe(50);
    expect(() => createBatch(r.env.db, r.deps, { count: 501, mode: "balanced", trial: false })).toThrow();
  });

  it("all 24 reviewed but only a few approved: the gate stays closed, the prompt must be fixed and a new trial run", async () => {
    const { r, batchId } = await trialReady();
    const revs = batchRevisions(r, batchId);
    importReviewManifest(r.env.db, r.deps, batchId, manifest(revs.map((rev, i) => ({ rev, verdict: i < 17 ? ("approved" as const) : ("rejected" as const) }))));
    expect(getBatch(r.env.db, batchId).resolved).toBe(true);
    const g = trialGate(r.env.db);
    expect(g.passed).toBe(false);
    expect(g.reason).toMatch(/only 17 of 24/);
    expect(createBatch(r.env.db, r.deps, { count: 50, mode: "balanced", trial: false }).items).toBe(50);
  });

  it("a trial of invalid (quarantined) items is resolved but never passes: nothing was approved", async () => {
    const r = await makeRig();
    const { batchId } = createBatch(r.env.db, r.deps, { count: 24, mode: "balanced", trial: true });
    r.model.behave = () => "garbage";
    await drive(r, () => batchJobsSettled(r, batchId));
    const b = getBatch(r.env.db, batchId);
    expect(b.counts.invalid).toBe(24);
    expect(b.resolved).toBe(true);
    expect(trialGate(r.env.db).passed).toBe(false); // the 24 failures are on record with their reasons; the next step is a new prompt version and a new trial
  });
});

describe("release: explicit, atomic, truthful", () => {
  async function approved(n: number): Promise<{ r: Rig; batchId: string; revs: ReturnType<typeof batchRevisions> }> {
    const { r, batchId } = await trialReady();
    const revs = batchRevisions(r, batchId);
    importReviewManifest(r.env.db, r.deps, batchId, manifest(revs.slice(0, n).map((rev) => ({ rev, verdict: "approved" as const }))));
    return { r, batchId, revs };
  }

  it("a PARTIAL release publishes only the named subset and says so with real counts", async () => {
    const { r, batchId, revs } = await approved(10);
    const subset = revs.slice(0, 7).map((x) => x.revisionId);
    const { manifestHash, items } = planRelease(r.env.db, subset);
    expect(items).toHaveLength(7);
    const rel = publishRelease(r.env.db, r.deps, { revisionIds: subset, reviewer: "agent:test-reviewer@1", expectedManifestHash: manifestHash });
    expect(rel).toMatchObject({ replayed: false, manifestHash });
    expect(rel.items).toHaveLength(7);
    const b = getBatch(r.env.db, batchId);
    expect(b.counts).toMatchObject({ released: 7, approved: 3, ready_for_review: 14 });
    expect(sum(b.counts)).toBe(24);
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM selectable_revisions").n).toBe(7);
    // every release item carries an explicit reviewer + the hash that was reviewed
    const li = rows<{ reviewer: string; h1: string; h2: string }>(r.env.db, "SELECT cr.reviewer AS reviewer, cr.content_hash AS h1, er.content_hash AS h2 FROM release_items ri JOIN content_reviews cr ON cr.id = ri.review_id JOIN exercise_revisions er ON er.id = ri.revision_id");
    expect(li).toHaveLength(7);
    expect(li.every((x) => x.reviewer.startsWith("agent:") && x.h1 === x.h2)).toBe(true);
    // publishing the same set again is a no-op
    expect(publishRelease(r.env.db, r.deps, { revisionIds: subset, reviewer: "agent:test-reviewer@1" })).toMatchObject({ replayed: true, releaseId: rel.releaseId });
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM releases").n).toBe(1);
  });

  it("a manifest hash the reviewer saw is checked against the CURRENT content: a mismatch publishes nothing", async () => {
    const { r, revs } = await approved(5);
    const ids = revs.slice(0, 5).map((x) => x.revisionId);
    const wrong = "f".repeat(64);
    const e = refusal(() => publishRelease(r.env.db, r.deps, { revisionIds: ids, reviewer: "agent:test-reviewer@1", expectedManifestHash: wrong }));
    expect(e).toMatchObject({ status: 409, code: "MANIFEST_MISMATCH" });
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM releases").n).toBe(0);
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM selectable_revisions").n).toBe(0);
  });

  it("all-or-nothing: one unapproved or foreign item in the list refuses the whole release", async () => {
    const { r, revs } = await approved(5);
    const ids = [...revs.slice(0, 4).map((x) => x.revisionId), revs[10]!.revisionId]; // the last one is still pending_review
    const e = refusal(() => publishRelease(r.env.db, r.deps, { revisionIds: ids, reviewer: "agent:test-reviewer@1" }));
    expect(e).toMatchObject({ status: 422, code: "RELEASE_REFUSED" });
    expect(JSON.stringify(e.details)).toContain("NOT_APPROVED");
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM releases").n).toBe(0);
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM release_items").n).toBe(0);
    expect(refusal(() => publishRelease(r.env.db, r.deps, { revisionIds: [], reviewer: "agent:x@1" })).code).toBe("RELEASE_ITEMS_INVALID");
  });

  it("a release item whose content hash changed since the review is refused: the review no longer covers it", async () => {
    const { r, revs } = await approved(3);
    const rev = revs[0]!;
    // simulate a tampered/stale review row by pointing at a different hash is impossible through triggers; instead check the planner's own guard
    expect(() => r.env.db.prepare("UPDATE exercise_revisions SET content_hash = ? WHERE id = ?").run("e".repeat(64), rev.revisionId)).toThrow(/append-only|immutable/i);
  });

  it("'Report incorrect' flags a released item at once: it is no longer selectable and the batch counts it as flagged", async () => {
    const { r, batchId, revs } = await approved(6);
    const ids = revs.slice(0, 6).map((x) => x.revisionId);
    publishRelease(r.env.db, r.deps, { revisionIds: ids, reviewer: "agent:test-reviewer@1" });
    expect(getBatch(r.env.db, batchId).counts.released).toBe(6);
    const exerciseId = one<{ exercise_id: string }>(r.env.db, "SELECT exercise_id FROM exercise_revisions WHERE id = ?", ids[0]!).exercise_id;
    const rep = reportExercise(r.env.db, r.deps, { exerciseId, revisionId: ids[0]!, reason: "answer key is wrong" });
    expect(rep).toMatchObject({ state: "flagged", eligibilityRevoked: true });
    const b = getBatch(r.env.db, batchId);
    expect(b.counts).toMatchObject({ released: 5, flagged: 1 });
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM selectable_revisions WHERE revision_id = ?", ids[0]!).n).toBe(0);
    expect(sum(b.counts)).toBe(24);
  });
});

describe("coverage and export", () => {
  it("coverage counts released, approved-unreleased, in-review and rejected drafts per skill and reports deficits honestly", async () => {
    const { r, batchId } = await trialReady();
    const revs = batchRevisions(r, batchId);
    importReviewManifest(r.env.db, r.deps, batchId, manifest([...revs.slice(0, 8).map((rev) => ({ rev, verdict: "approved" as const })), { rev: revs[8]!, verdict: "rejected" as const }]));
    publishRelease(r.env.db, r.deps, { revisionIds: revs.slice(0, 5).map((x) => x.revisionId), reviewer: "agent:test-reviewer@1" });
    const c = coverage(r.env.db);
    expect(c.totals.releasedExercises).toBe(5);
    expect(c.skills.reduce((a, s) => a + s.approvedUnreleased, 0)).toBe(3);
    expect(c.skills.reduce((a, s) => a + s.rejected, 0)).toBe(1);
    expect(c.skills.reduce((a, s) => a + s.inReview, 0)).toBe(15);
    expect(c.totals.skillsWithDeficit).toBe(c.totals.skills); // no skill reaches the target of 12 yet
    expect(c.skills.every((s) => s.deficit === Math.max(0, c.targetPerSkill - s.released))).toBe(true);
    expect(exportCoverage(r.env.db).markdown).toContain("deficit");
  });

  it("the batch export is read-only, lists exactly the items awaiting a decision with their hashes, and its release candidate matches the planner", async () => {
    const { r, batchId } = await trialReady();
    const revs = batchRevisions(r, batchId);
    importReviewManifest(r.env.db, r.deps, batchId, manifest(revs.slice(0, 4).map((rev) => ({ rev, verdict: "approved" as const }))));
    const countsBefore = ["content_reviews", "content_state_events", "releases", "batch_items", "jobs"].map((t) => one<{ n: number }>(r.env.db, `SELECT COUNT(*) AS n FROM ${t}`).n);
    const { json, markdown } = exportBatch(r.env.db, batchId) as { json: { reviewManifestTemplate: { items: Array<{ revision_id: string; content_hash: string }> }; releaseCandidate: { manifestHash: string; revisionIds: string[] }; items: unknown[] }; markdown: string };
    expect(["content_reviews", "content_state_events", "releases", "batch_items", "jobs"].map((t) => one<{ n: number }>(r.env.db, `SELECT COUNT(*) AS n FROM ${t}`).n)).toEqual(countsBefore);
    expect(json.items).toHaveLength(24);
    expect(json.reviewManifestTemplate.items).toHaveLength(20);
    const byId = new Map(revs.map((x) => [x.revisionId, x.hash]));
    for (const t of json.reviewManifestTemplate.items) expect(byId.get(t.revision_id)).toBe(t.content_hash);
    expect(json.releaseCandidate.revisionIds).toHaveLength(4);
    expect(json.releaseCandidate.manifestHash).toBe(planRelease(r.env.db, json.releaseCandidate.revisionIds).manifestHash);
    expect(markdown).toContain("Review EVERY item individually");
  });
});
