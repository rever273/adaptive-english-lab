import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { EXERCISE_TYPES } from "@english-lab/contracts";
import { createBatch, getBatch, trialGate } from "../../../apps/server/src/domain/content/batches/repository.js";
import { planBatch } from "../../../apps/server/src/domain/content/batches/plan.js";
import { ensurePromptVersion } from "../../../apps/server/src/domain/ai/prompts.js";
import { draftFormatsText } from "../../../apps/server/src/domain/content/batches/draftFormats.js";
import { applyAction, enqueue, getJob } from "../../../apps/server/src/queue/jobs.js";
import { one, rows } from "../attempts/fixtures.js";
import { batchJobsSettled, closeRigs, drive, goodDraft, makeRig, transient, type Rig } from "./fixtures.js";

afterEach(closeRigs);

const trial = (r: Rig) => createBatch(r.env.db, r.deps, { count: 24, mode: "balanced", trial: true });
const run = async (r: Rig, batchId: string) => drive(r, () => batchJobsSettled(r, batchId));
const statesOf = (r: Rig, revisionId: string) => rows<{ to_status: string; actor_type: string }>(r.env.db, "SELECT to_status, actor_type FROM content_state_events WHERE revision_id = ? ORDER BY sequence", revisionId).map((e) => `${e.to_status}:${e.actor_type}`);

describe("planning and queuing", () => {
  it("creates a new-version batch while the prior prompt is already registered", async () => {
    const r = await makeRig();
    ensurePromptVersion(r.env.db, "generation-v8", draftFormatsText("generation-v8"));
    const created = createBatch(r.env.db, r.deps, { count: 10, mode: "adaptive", category: "grammar" });
    expect(created.items).toBe(10);
    expect(one<{ v: string }>(r.env.db, "SELECT prompt_version_id AS v FROM batches WHERE id = ?", created.batchId).v).toBe("generation-v9");
    expect(() => ensurePromptVersion(r.env.db, "generation-v8", draftFormatsText("generation-v8"))).not.toThrow();
  });
  it("a trial is exactly 24 drafts, 4 per format, in fourteen short same-format units (2 per call, 1 for reading), all queued; no model is called to create it", async () => {
    const r = await makeRig();
    const c = trial(r);
    expect(c).toMatchObject({ purpose: "trial", items: 24, units: 14 });
    const b = getBatch(r.env.db, c.batchId);
    expect(b.counts.queued).toBe(24);
    expect(Object.values(b.counts).reduce((a, n) => a + n, 0)).toBe(24);
    for (const t of EXERCISE_TYPES) expect(b.items!.filter((i) => i.plan.type === t)).toHaveLength(4);
    const jobs = rows<{ kind: string; state: string; priority: number; batch_id: string; payload_json: string }>(r.env.db, "SELECT kind, state, priority, batch_id, payload_json FROM jobs");
    expect(jobs).toHaveLength(14);
    expect(jobs.every((j) => j.kind === "generation" && j.state === "queued" && j.priority === 3 && j.batch_id === c.batchId)).toBe(true);
    expect(jobs.every((j) => (JSON.parse(j.payload_json) as { ordinals: number[] }).ordinals.length <= 2)).toBe(true);
    expect(r.model.calls).toBe(0);
    expect(one<{ prompt_version_id: string }>(r.env.db, "SELECT prompt_version_id FROM batches").prompt_version_id).toBe("generation-v9");
  });

  it("is deterministic, covers the thinnest skills first in adaptive mode and refuses unknown skills", async () => {
    const r = await makeRig();
    const skills = rows<{ skill_id: string }>(r.env.db, "SELECT skill_id FROM skill_revisions WHERE active = 1 ORDER BY skill_id").map((s) => s.skill_id);
    const input = { request: { count: 12, mode: "adaptive" as const, trial: false, types: ["choose_form" as const] }, taxonomySkills: skills, coverage: new Map([[skills[0]!, 5]]), tag: "t" };
    const a = planBatch(input);
    expect(planBatch(input)).toEqual(a);
    expect(a.map((p) => p.target_skill)).not.toContain(skills[0]); // the covered skill goes last, 12 items fit in the other skills
    expect(() => planBatch({ ...input, request: { ...input.request, skills: ["no.such_skill"] } })).toThrow(/not in the current taxonomy/);
    expect(() => planBatch({ ...input, request: { ...input.request, mode: "manual" } })).toThrow(/explicit list/);
  });
});

describe("generation through the dispatcher produces DRAFTS only", () => {
  it("24 trial items become validated drafts awaiting individual review: never approved, never selectable", async () => {
    const r = await makeRig();
    const { batchId } = trial(r);
    await run(r, batchId);
    const b = getBatch(r.env.db, batchId);
    expect(b.counts.ready_for_review).toBe(24);
    expect(b.counts.released + b.counts.approved).toBe(0);
    expect(b.generationDone).toBe(true);
    expect(b.resolved).toBe(false); // nothing reviewed yet
    const rev = b.items![0]!.revisionId!;
    expect(statesOf(r, rev)).toEqual(["draft:model", "validated:code", "pending_review:code"]);
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM selectable_revisions").n).toBe(0);
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM content_reviews").n).toBe(0);
    // provenance is written by the server from the pinned model, and the exercise belongs to the batch
    const content = JSON.parse(one<{ c: string }>(r.env.db, "SELECT content_json AS c FROM exercise_revisions WHERE id = ?", rev).c) as { provenance: { origin: string; model_tag: string; model_digest: string; prompt_version: string }; status: string; bank_role: string };
    expect(content).toMatchObject({ status: "draft", bank_role: "practice", provenance: { origin: "qwen", model_tag: "gemma4:12b", prompt_version: "generation-v9" } });
    expect(content.provenance.model_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM exercises WHERE source_batch_id = ?", batchId).n).toBe(24);
    expect(r.model.calls).toBe(14);
    expect(Math.max(...r.model.units.map((u) => u.count))).toBeLessThanOrEqual(2);
  });

  it("MALICIOUS output is refused: a model cannot claim approval, a heldout role, another format or another skill", async () => {
    const r = await makeRig();
    const { batchId } = trial(r);
    r.model.behave = (_c, u) =>
      JSON.stringify({
        drafts: u.items.map((i) => {
          const e = goodDraft(u.format, i);
          if (i.ordinal === 0) e.status = "approved";
          if (i.ordinal === 1) e.bank_role = "heldout";
          if (i.ordinal === 2) e.target_skill = "articles.definite";
          if (i.ordinal === 3) e.confirmed = true;
          if (i.ordinal === 4) e.type = "detect_error";
          if (i.ordinal === 5) e.approved_by = "agent:me";
          return e;
        }),
      });
    await run(r, batchId);
    const b = getBatch(r.env.db, batchId);
    const bad = new Map(b.items!.map((i) => [i.ordinal, i]));
    for (const o of [0, 1, 2, 3, 4, 5]) {
      expect(bad.get(o)!.status, `ordinal ${o}`).toBe("invalid");
      expect(bad.get(o)!.revisionId).toBeNull();
    }
    expect(JSON.stringify(bad.get(0)!.error)).toContain("MODEL_CLAIMED_FIELD");
    expect(JSON.stringify(bad.get(1)!.error)).toContain("MODEL_CLAIMED_FIELD");
    expect(JSON.stringify(bad.get(2)!.error)).toContain("MODEL_CLAIMED_FIELD");
    expect(JSON.stringify(bad.get(5)!.error)).toContain("UNEXPECTED_FIELD");
    // nothing a model wrote is approved, selectable or reviewed
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM latest_content_state WHERE status NOT IN ('pending_review')").n).toBe(0);
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM selectable_revisions").n).toBe(0);
    expect(Object.values(b.counts).reduce((a, n) => a + n, 0)).toBe(24);
  });

  it("the database itself refuses a model that tries to approve or review (backstop beneath the application)", async () => {
    const r = await makeRig();
    const { batchId } = trial(r);
    await run(r, batchId);
    const rev = getBatch(r.env.db, batchId).items![0]!;
    const insert = (to: string, actor: string, from = "pending_review", seq = 3) =>
      r.env.db.prepare("INSERT INTO content_state_events(id, revision_id, sequence, from_status, to_status, actor_type, actor_id, reason, content_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), rev.revisionId, seq + 1, from, to, actor, "qwen", "x", rev.contentHash, "2026-10-29T00:00:00Z");
    expect(() => insert("approved", "model")).toThrow(/not authorised|requires/);
    expect(() => insert("approved", "code")).toThrow(/not authorised|requires/);
    expect(() => insert("approved", "agent")).toThrow(/approval requires/); // even an agent needs a matching approved review first
  });

  it("an unparseable answer after the single repair quarantines the whole unit as invalid; the job itself completes", async () => {
    const r = await makeRig();
    const { batchId } = trial(r);
    r.model.behave = () => "Sure! Here are your exercises: ...";
    await run(r, batchId);
    const b = getBatch(r.env.db, batchId);
    expect(b.counts.invalid).toBe(24);
    expect(r.model.calls).toBe(76); // initial unit attempts and bounded individual retries
    expect(rows(r.env.db, "SELECT state FROM jobs WHERE state <> 'completed'")).toHaveLength(0);
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM exercise_revisions").n).toBe(0);
    expect(JSON.stringify(b.items![0]!.error)).toContain("NOT_JSON");
  });

  it("fewer drafts than requested: retries ambiguous units individually without guessing ordinals", async () => {
    const r = await makeRig();
    const { batchId } = trial(r);
    r.model.behave = (_c, u) => JSON.stringify({ drafts: [goodDraft(u.format, u.items[0]!)] });
    await run(r, batchId);
    const b = getBatch(r.env.db, batchId);
    expect(b.counts.ready_for_review).toBe(24);
    expect(b.counts.invalid).toBe(0);
  });

  it("a repair that succeeds is accepted", async () => {
    const r = await makeRig();
    const { batchId } = trial(r);
    const base = r.model.behave;
    r.model.behave = (c, u) => (c % 2 === 1 ? "not json" : base(c, u));
    await run(r, batchId);
    expect(getBatch(r.env.db, batchId).counts.ready_for_review).toBe(24);
    expect(r.model.calls).toBe(28);
  });

  it("an identical sentence already in the bank, or twice in one unit, is quarantined by the server's own global dedupe", async () => {
    const r = await makeRig();
    const { batchId } = trial(r);
    r.model.behave = (_c, u) => JSON.stringify({ drafts: u.items.map((i) => goodDraft(u.format, { ...i, ordinal: 0 })) }); // every item claims the SAME sentences
    await run(r, batchId);
    const b = getBatch(r.env.db, batchId);
    expect(b.counts.ready_for_review).toBe(7); // the first draft of each format, plus the one distinct "no mistake" sentence of detect_error
    expect(b.counts.invalid).toBe(17);
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM exercise_revisions").n).toBe(7);
  });
});

describe("crash, retry and duplicate delivery", () => {
  it("partial failure then restart: finished units stay, the failed unit is retried, each ordinal exists exactly once", async () => {
    const r = await makeRig();
    const { batchId } = trial(r);
    let failing = true;
    const base = r.model.behave;
    r.model.behave = (c, u) => (failing && u.items[0]!.ordinal === 8 ? transient() : base(c, u));
    await run(r, batchId);
    const failed = rows<{ id: string; state: string; payload_json: string }>(r.env.db, "SELECT id, state, payload_json FROM jobs WHERE state = 'failed'");
    expect(failed).toHaveLength(1);
    expect(JSON.parse(failed[0]!.payload_json)).toMatchObject({ ordinals: [8, 9] });
    let b = getBatch(r.env.db, batchId);
    expect(b.counts.ready_for_review).toBe(22); // the other thirteen units are done and intact
    expect(b.counts.invalid).toBe(2); // terminal generation failures are available for agent repair or explicit retry
    expect(b.generationDone).toBe(true);

    failing = false;
    const before = rows<{ revision_id: string }>(r.env.db, "SELECT revision_id FROM batch_items WHERE revision_id IS NOT NULL").map((x) => x.revision_id).sort();
    applyAction(r.env.db, r.deps, failed[0]!.id, "retry");
    await run(r, batchId);
    b = getBatch(r.env.db, batchId);
    expect(b.counts.ready_for_review).toBe(24);
    expect(b.counts.queued).toBe(0);
    const after = rows<{ revision_id: string }>(r.env.db, "SELECT revision_id FROM batch_items WHERE revision_id IS NOT NULL").map((x) => x.revision_id).sort();
    expect(after).toHaveLength(24);
    expect(new Set(after).size).toBe(24);
    for (const id of before) expect(after).toContain(id); // earlier revisions were not rewritten
    expect(rows<{ ordinal: number }>(r.env.db, "SELECT ordinal FROM batch_items WHERE batch_id = ? ORDER BY ordinal", batchId).map((x) => x.ordinal)).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });

  it("duplicate delivery of a finished unit asks the model for nothing and writes nothing", async () => {
    const r = await makeRig();
    const { batchId } = trial(r);
    await run(r, batchId);
    const callsBefore = r.model.calls;
    const revisionsBefore = one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM exercise_revisions").n;
    const dup = enqueue(r.env.db, r.deps, { kind: "generation", payload: { batchId, ordinals: [0, 1, 2, 3] }, idempotencyKey: "redelivered", batchId, priority: 3 }).job;
    await drive(r, () => getJob(r.env.db, dup.id)!.state === "completed");
    expect(r.model.calls).toBe(callsBefore);
    expect(one<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM exercise_revisions").n).toBe(revisionsBefore);
    expect(getBatch(r.env.db, batchId).counts.ready_for_review).toBe(24);
  });

  it("a drifted model digest stops generation before any model call; failures are exposed for repair", async () => {
    const r = await makeRig();
    const { batchId } = trial(r);
    r.digest.current = "sha256-other";
    await run(r, batchId);
    expect(r.model.calls).toBe(0);
    expect(getBatch(r.env.db, batchId).counts.invalid).toBe(24);
    expect(rows<{ error_code: string }>(r.env.db, "SELECT DISTINCT error_code FROM jobs").map((j) => j.error_code)).toEqual(["model_digest_mismatch"]);
  });
});

describe("legacy trial diagnostics and regular replenishment", () => {
  it("allows regular batches without a trial, retaining historical trial diagnostics", async () => {
    const r = await makeRig();
    expect(createBatch(r.env.db, r.deps, { count: 50, mode: "balanced", trial: false }).items).toBe(50);
    const { batchId } = trial(r);
    expect(trialGate(r.env.db).passed).toBe(false);
    await run(r, batchId);
    expect(trialGate(r.env.db).passed).toBe(false); // generated, but not reviewed
    expect(createBatch(r.env.db, r.deps, { count: 50, mode: "balanced", trial: false }).items).toBe(50);
    expect(() => createBatch(r.env.db, r.deps, { count: 20, mode: "balanced", trial: true })).toThrow(/CHECK|24|trial/i);
  });
});
