import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { recordAttempt } from "../../../apps/server/src/domain/attempts/attempts.js";
import { recordSessionEvent } from "../../../apps/server/src/domain/attempts/sessionEvents.js";
import { activityProgress } from "../../../apps/server/src/domain/sessions/xp.js";
import { loadAttemptFacts, loadSlotFacts } from "../../../apps/server/src/domain/reports/facts.js";
import { addEvent, exactSetAssessor, makeEnv, makeRevision, makeSession, makeSlot, type Env } from "../attempts/fixtures.js";

let env: Env | undefined;
afterEach(() => { env?.cleanup(); env = undefined; });

describe("vocabulary session category migration", () => {
  it("adds an immutable category without changing older sessions", async () => {
    env = await makeEnv();
    const old = makeSession(env);
    const vocabulary = makeSession(env);
    env.db.prepare("INSERT INTO vocabulary_sessions(session_id, created_at) VALUES (?, ?)").run(vocabulary, "2026-01-01T00:00:00Z");
    expect(env.db.prepare("SELECT session_id FROM vocabulary_sessions WHERE session_id = ?").get(old)).toBeUndefined();
    expect(env.db.prepare("SELECT session_id FROM vocabulary_sessions WHERE session_id = ?").get(vocabulary)).toEqual({ session_id: vocabulary });
    expect(() => env!.db.prepare("DELETE FROM vocabulary_sessions WHERE session_id = ?").run(vocabulary)).toThrow(/append-only/);
    expect(() => env!.db.prepare("UPDATE vocabulary_sessions SET created_at = ? WHERE session_id = ?").run("later", vocabulary)).toThrow(/append-only/);
    expect(env.db.pragma("foreign_key_check")).toEqual([]);
  });

  it("keeps vocabulary assessments in the event history without creating grammar opportunities", async () => {
    env = await makeEnv({ assessor: exactSetAssessor() });
    const session = makeSession(env);
    env.db.prepare("INSERT INTO vocabulary_sessions(session_id, created_at) VALUES (?, ?)").run(session, "2026-01-01T00:00:00Z");
    const slot = makeSlot(env, session, makeRevision(env), 0);
    addEvent(env, session, slot, "reveal");
    const result = recordAttempt(env.db, env.deps, { slotId: slot, submissionId: randomUUID(), answer: ["a"], inputMode: "text" });
    expect(result.body.assessment.verdict).toBe("correct");
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM assessment_revisions").get()).toEqual({ n: 1 });
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM skill_opportunities").get()).toEqual({ n: 0 });
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM error_events").get()).toEqual({ n: 0 });

    const oldSession = makeSession(env);
    const oldSlot = makeSlot(env, oldSession, makeRevision(env), 0);
    addEvent(env, oldSession, oldSlot, "reveal");
    expect(() => env!.db.prepare("INSERT INTO vocabulary_sessions VALUES (?, ?)").run(oldSession, "later")).toThrow(/precede activity/);
    recordAttempt(env.db, env.deps, { slotId: oldSlot, submissionId: randomUUID(), answer: ["a"], inputMode: "text" });
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM skill_opportunities").get()).toEqual({ n: 1 });
    const asOf = "2030-01-01T00:00:00.000Z";
    const cohort = { criterionVersion: "rubric-v1", difficulty: "B2" as const, protocol: "practice" as const };
    expect(loadAttemptFacts(env.db, { watermark: 999, asOf, cohort: null }).map((a) => a.sessionId)).toEqual([oldSession]);
    expect(loadSlotFacts(env.db, { sessionEventWatermark: 999, asOf, cohort }).map((a) => a.sessionId)).toEqual([oldSession]);
    const event = { slotId: slot, type: "continue" as const, clientEventId: randomUUID() };
    recordSessionEvent(env.db, env.deps, session, event);
    recordSessionEvent(env.db, env.deps, session, event);
    expect(activityProgress(env.db, "vocabulary")).toMatchObject({ total: 10, level: 1, withinLevel: 10 });
    expect(activityProgress(env.db, "grammar").total).toBe(0);
    recordSessionEvent(env.db, env.deps, oldSession, { slotId: oldSlot, type: "continue", clientEventId: randomUUID() });
    expect(activityProgress(env.db, "grammar").total).toBe(10);
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM activity_xp_events").get()).toEqual({ n: 2 });
  });
});
