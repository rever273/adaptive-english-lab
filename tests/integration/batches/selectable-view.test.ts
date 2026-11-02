import { afterEach, describe, expect, it } from "vitest";
import { importReviewManifest } from "../../../apps/server/src/domain/content/batches/reviewImport.js";
import { createBatch } from "../../../apps/server/src/domain/content/batches/repository.js";
import { publishRelease, reportExercise } from "../../../apps/server/src/domain/content/repository.js";
import { one, rows } from "../attempts/fixtures.js";
import { batchJobsSettled, batchRevisions, closeRigs, drive, makeRig, manifest } from "./fixtures.js";

afterEach(closeRigs);

/** The definition of `selectable_revisions` from migration 004 (before the speed-up of migration 023). */
const OLD_DEFINITION = `
  SELECT er.id AS revision_id, er.exercise_id, er.type, er.dimension, er.difficulty, er.bank_role, er.content_hash
  FROM exercise_revisions er
  JOIN latest_content_state s ON s.revision_id = er.id AND s.status = 'approved'
  WHERE EXISTS (
    SELECT 1 FROM release_items ri JOIN content_reviews cr ON cr.id = ri.review_id
     WHERE ri.revision_id = er.id AND cr.verdict = 'approved' AND cr.content_hash = er.content_hash
  )
  ORDER BY revision_id`;

describe("selectable_revisions after migration 023", () => {
  it("returns exactly the rows of the migration-004 definition in every content state", async () => {
    const r = await makeRig();
    const { batchId } = createBatch(r.env.db, r.deps, { count: 24, mode: "balanced", trial: true });
    await drive(r, () => batchJobsSettled(r, batchId));
    const revs = batchRevisions(r, batchId);
    // 10 approved, 3 flagged, 3 rejected, the rest left in review
    importReviewManifest(r.env.db, r.deps, batchId, manifest([
      ...revs.slice(0, 10).map((rev) => ({ rev, verdict: "approved" as const })),
      ...revs.slice(10, 13).map((rev) => ({ rev, verdict: "flagged" as const })),
      ...revs.slice(13, 16).map((rev) => ({ rev, verdict: "rejected" as const })),
    ]));
    const compare = () => {
      const now = rows<Record<string, unknown>>(r.env.db, "SELECT * FROM selectable_revisions ORDER BY revision_id");
      expect(now).toEqual(rows(r.env.db, OLD_DEFINITION));
      return now;
    };
    // approved but not published: not selectable
    expect(compare()).toHaveLength(0);
    // release six of the ten; four stay approved-unreleased
    const released = revs.slice(0, 6).map((x) => x.revisionId);
    publishRelease(r.env.db, r.deps, { revisionIds: released, reviewer: "agent:test-reviewer@1" });
    expect(compare().map((x) => x.revision_id).sort()).toEqual([...released].sort());
    // flagged after release (several state events on one revision): leaves the view in both definitions
    const exerciseId = one<{ exercise_id: string }>(r.env.db, "SELECT exercise_id FROM exercise_revisions WHERE id = ?", released[0]!).exercise_id;
    reportExercise(r.env.db, r.deps, { exerciseId, revisionId: released[0]!, reason: "answer key is wrong" });
    expect(compare().map((x) => x.revision_id)).not.toContain(released[0]);
    expect(compare()).toHaveLength(5);
  });
});
