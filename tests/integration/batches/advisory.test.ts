import { afterEach, describe, expect, it } from "vitest";
import { exportBatch } from "../../../apps/server/src/domain/content/batches/export.js";
import { createBatch, getBatch } from "../../../apps/server/src/domain/content/batches/repository.js";
import { getJob } from "../../../apps/server/src/queue/jobs.js";
import { one, rows } from "../attempts/fixtures.js";
import { batchJobsSettled, closeRigs, drive, makeRig, type Rig } from "./fixtures.js";

afterEach(closeRigs);

const triageJobs = (r: Rig) => rows<{ id: string; state: string; error_code: string | null; batch_id: string | null }>(r.env.db, "SELECT id, state, error_code, batch_id FROM jobs WHERE kind = 'triage'");
const allTriageDone = (r: Rig) => triageJobs(r).every((j) => ["completed", "failed", "cancelled"].includes(j.state));

async function screened(opts: { score?: (t: string) => number } = {}): Promise<{ r: Rig; batchId: string }> {
  const r = await makeRig({ advisory: true });
  if (opts.score) r.nimble.score = opts.score;
  const { batchId } = createBatch(r.env.db, r.deps, { count: 24, mode: "balanced", trial: true });
  await drive(r, () => batchJobsSettled(r, batchId) && triageJobs(r).length === 24 && allTriageDone(r));
  return { r, batchId };
}

describe("Nimble as a hint for the reviewer (advisory only)", () => {
  it("every stored draft gets one screening job; the batch counts as generated without waiting for it", async () => {
    const { r, batchId } = await screened();
    const jobs = triageJobs(r);
    expect(jobs).toHaveLength(24);
    expect(jobs.every((j) => j.state === "completed" && j.batch_id === null)).toBe(true); // not tied to the batch: advice never blocks it
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM advisory_signals").n).toBe(24);
    expect(getBatch(r.env.db, batchId).generationDone).toBe(true);
  });

  it("flags follow fixed rules: a distractor that reads fine, or a key that reads wrong, becomes a hint with its raw score", async () => {
    // default stand-in: everything scores 0.01 = "reads fine"  => every sentence that SHOULD read wrong is flagged
    const { r, batchId } = await screened();
    const items = getBatch(r.env.db, batchId).items!;
    const flagged = items.filter((i) => (i.advisory?.flags ?? []).length > 0);
    const expectFlagged = items.filter((i) => ["choose_form", "choose_missing_fragment"].includes(i.plan.type) || (i.plan.type === "detect_error" && !i.plan.noMistake));
    expect(flagged.map((i) => i.ordinal).sort()).toEqual(expectFlagged.map((i) => i.ordinal).sort());
    const f = flagged[0]!.advisory!.flags[0] as { code: string; score: number; text: string };
    expect(f).toMatchObject({ code: "DISTRACTOR_LOOKS_OK", score: 0.01 });
    // and the reverse: everything scores "wrong" => keys are flagged, distractors are not
    const wrong = await screened({ score: () => 0.9 });
    const w = getBatch(wrong.r.env.db, wrong.batchId).items!;
    expect(w.every((i) => (i.advisory!.flags as Array<{ code: string }>).every((x) => x.code === "KEY_LOOKS_WRONG"))).toBe(true);
    expect(w.filter((i) => (i.advisory!.flags as unknown[]).length > 0).length).toBe(24);
  });

  it("a hint has NO authority: states, reviews, releases and selection are exactly as without it", async () => {
    const { r, batchId } = await screened({ score: () => 0.9 }); // the loudest possible advice
    const b = getBatch(r.env.db, batchId);
    expect(b.counts.ready_for_review).toBe(24);
    expect(b.counts.rejected + b.counts.approved + b.counts.flagged + b.counts.released).toBe(0);
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM content_reviews").n).toBe(0);
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM selectable_revisions").n).toBe(0);
    // the only state events are the three the generator writes (draft by the model, validated + pending_review by code)
    expect(rows<{ actor_type: string; to_status: string }>(r.env.db, "SELECT DISTINCT actor_type, to_status FROM content_state_events ORDER BY 1, 2")).toEqual([
      { actor_type: "code", to_status: "pending_review" },
      { actor_type: "code", to_status: "validated" },
      { actor_type: "model", to_status: "draft" },
    ]);
    // the table has no verdict-like column and is append-only
    const cols = rows<{ name: string }>(r.env.db, "PRAGMA table_info(advisory_signals)").map((c) => c.name);
    expect(cols.some((c) => /status|verdict|approved|confirmed/.test(c))).toBe(false);
    expect(() => r.env.db.prepare("UPDATE advisory_signals SET flags_json = '[]'").run()).toThrow(/append-only/);
    expect(() => r.env.db.prepare("DELETE FROM advisory_signals").run()).toThrow(/append-only/);
  });

  it("duplicate delivery adds nothing; a drifted Nimble digest fails only the hint job, never the generation", async () => {
    const { r } = await screened();
    const rev = one<{ revision_id: string }>(r.env.db, "SELECT revision_id FROM advisory_signals LIMIT 1").revision_id;
    const callsBefore = r.nimble.calls;
    const { enqueue } = await import("../../../apps/server/src/queue/jobs.js");
    const dup = enqueue(r.env.db, r.deps, { kind: "triage", payload: { revisionId: rev }, idempotencyKey: "again", priority: 3 }).job;
    await drive(r, () => getJob(r.env.db, dup.id)!.state === "completed");
    expect(r.nimble.calls).toBe(callsBefore);
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM advisory_signals").n).toBe(24);

    const r2 = await makeRig({ advisory: true });
    r2.nimbleDigest.current = "sha256-other";
    const { batchId } = createBatch(r2.env.db, r2.deps, { count: 24, mode: "balanced", trial: true });
    await drive(r2, () => batchJobsSettled(r2, batchId) && triageJobs(r2).length === 24 && allTriageDone(r2));
    expect(getBatch(r2.env.db, batchId).counts.ready_for_review).toBe(24);
    expect(triageJobs(r2).every((j) => j.state === "failed" && j.error_code === "model_digest_mismatch")).toBe(true);
    expect(r2.nimble.calls).toBe(0);
  });

  it("the reviewer's export carries the hints, labelled as advice", async () => {
    const { r, batchId } = await screened();
    const { json, markdown } = exportBatch(r.env.db, batchId) as { json: { items: Array<{ advisoryHints: { note: string; flags: unknown[] } | null }> }; markdown: string };
    expect(json.items.every((i) => i.advisoryHints !== null)).toBe(true);
    expect(json.items[0]!.advisoryHints!.note).toMatch(/not a verdict/);
    expect(markdown).toContain("HINTS (small-model advice, verify yourself)");
  });
});
