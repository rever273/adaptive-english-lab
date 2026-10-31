// TASK_021: the target difficulty range limits which approved exercises are selected (shortage is reported, never silently lowered),
// and the finished-session summary carries a live count of answers whose local AI check has not produced its draft yet.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { recordAttempt } from "../../../apps/server/src/domain/attempts/attempts.js";
import { recordSessionEvent } from "../../../apps/server/src/domain/attempts/sessionEvents.js";
import { loadCandidates } from "../../../apps/server/src/domain/sessions/bank.js";
import { createPracticeSession } from "../../../apps/server/src/domain/sessions/create.js";
import { finishSession } from "../../../apps/server/src/domain/sessions/finish.js";
import { takeLease } from "../../../apps/server/src/domain/sessions/lease.js";
import { computeReadiness } from "../../../apps/server/src/domain/sessions/readiness.js";
import { revealSlot } from "../../../apps/server/src/domain/sessions/reveal.js";
import { getSnapshot } from "../../../apps/server/src/domain/sessions/snapshot.js";
import { applyAction, enqueue } from "../../../apps/server/src/queue/jobs.js";
import { ApiError } from "../../../apps/server/src/errors.js";
import { buildSliceTemplate, disposeSliceTemplate, openSliceCopy, type SliceEnv } from "./slice-fixture.js";

let env: SliceEnv;
beforeAll(() => {
  buildSliceTemplate();
}, 180_000);
afterAll(() => disposeSliceTemplate());
afterEach(() => env?.cleanup());

/** a new settings revision on top of the current one (history is appended, never rewritten) */
function setSettings(patch: Record<string, unknown>): void {
  const cur = env.db.prepare("SELECT revision, values_json AS v FROM settings_revisions ORDER BY revision DESC LIMIT 1").get() as { revision: number; v: string };
  env.db.prepare("INSERT INTO settings_revisions(id, revision, values_json, created_at) VALUES (?,?,?,?)").run(randomUUID(), cur.revision + 1, JSON.stringify({ ...JSON.parse(cur.v), ...patch }), env.clock.current.toISOString());
}
const begin = () => createPracticeSession(env.db, env.deps, { purpose: "practice", blueprintRevisionId: env.blueprintRevisionId, seed: "seed-1", timezone: "Australia/Brisbane" });

describe("target difficulty range (T4)", () => {
  it("filters the candidates by CEFR label; null keeps every level", () => {
    env = openSliceCopy();
    const all = loadCandidates(env.db, "practice");
    expect(all.length).toBeGreaterThan(0);
    expect(new Set(all.map((c) => c.difficulty))).toEqual(new Set(["B2"])); // the slice bank is B2 only
    expect(loadCandidates(env.db, "practice", [], ["B2", "C1"])).toHaveLength(all.length);
    expect(loadCandidates(env.db, "practice", [], ["C1"])).toHaveLength(0);
    expect(loadCandidates(env.db, "practice", [], ["A2", "B1"])).toHaveLength(0);
  });

  it("a range that contains the stock behaves like no setting; one that does not shows the shortage and never lowers the level", () => {
    env = openSliceCopy();
    const baseline = computeReadiness(env.db, env.deps, env.blueprintRevisionId).readySessions;
    expect(baseline).toBeGreaterThan(0);

    setSettings({ difficultyMin: "B2", difficultyMax: "C1" });
    expect(computeReadiness(env.db, env.deps, env.blueprintRevisionId).readySessions).toBe(baseline);

    setSettings({ difficultyMin: "C1", difficultyMax: "C1" });
    const r = computeReadiness(env.db, env.deps, env.blueprintRevisionId);
    expect(r.readySessions).toBe(0);
    expect(r.shortage?.deficits.length).toBeGreaterThan(0);
    try {
      begin();
      throw new Error("expected a shortage");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe("CONTENT_SHORTAGE");
    }
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 }); // nothing was built from easier exercises

    setSettings({ difficultyMin: "A2", difficultyMax: "C1" }); // the whole range = no restriction
    expect(computeReadiness(env.db, env.deps, env.blueprintRevisionId).readySessions).toBe(baseline);
  });
});

describe("live AI-check counter in the summary (T3c)", () => {
  it("counts a written answer until its analysis job has finished, and never calls the draft confirmed", () => {
    env = openSliceCopy();
    const { sessionId } = begin();
    takeLease(env.db, env.deps, sessionId, "tab-1");
    const slots = getSnapshot(env.db, sessionId).slots;
    const production = slots.find((s) => s.format === "guided_short_answer" || s.format === "russian_to_english_short");
    expect(production).toBeDefined();
    for (const s of slots) {
      revealSlot(env.db, env.deps, sessionId, s.slotId, "tab-1");
      if (s !== production) recordSessionEvent(env.db, env.deps, sessionId, { slotId: s.slotId, type: "skip", clientEventId: randomUUID() });
    }
    const att = recordAttempt(env.db, env.deps, { slotId: production!.slotId, submissionId: randomUUID(), answer: "A perfectly grammatical but unapproved sentence about the weather today.", inputMode: "text" });
    recordSessionEvent(env.db, env.deps, sessionId, { slotId: production!.slotId, type: "continue", clientEventId: randomUUID() });
    const attemptId = (env.db.prepare("SELECT id FROM attempts WHERE slot_id = ?").get(production!.slotId) as { id: string }).id;
    expect(att).toBeTruthy();
    const job = enqueue(env.db, env.deps, { kind: "free_text_analysis", payload: { slotId: production!.slotId, attemptId }, idempotencyKey: `free_text_analysis:${attemptId}` }).job;

    const during = finishSession(env.db, env.deps, sessionId, "completed");
    expect(during.counts.pending).toBe(1);
    expect(during.aiWaiting).toBe(1);

    applyAction(env.db, env.deps, job.id, "cancel"); // any job that is no longer queued/running stops counting as waiting
    const after = finishSession(env.db, env.deps, sessionId, "completed"); // idempotent: the same summary, re-read
    expect(after.aiWaiting).toBe(0);
    expect(after.counts.pending).toBe(1); // still not counted: an AI draft is not a confirmed assessment
  });
});
