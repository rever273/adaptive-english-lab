import Fastify from "fastify";
import { registerSessionRoutes } from "../../../apps/server/src/routes/sessions.js";
import { registerErrorHandling } from "../../../apps/server/src/errors.js";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordPracticeActivity } from "../../../apps/server/src/domain/sessions/activity.js";
import { takeLease } from "../../../apps/server/src/domain/sessions/lease.js";
import { advance, makeEnv, makeSession, type Env } from "./fixtures.js";

let env: Env;
beforeEach(async () => { env = await makeEnv(); });
afterEach(() => env.cleanup());

describe("practice activity ledger", () => {
  it("records independent, idempotent intervals without altering attempts", () => {
    const s = makeSession(env); takeLease(env.db, env.deps, s, "tab"); const start = env.clock.current.getTime(); advance(env, 5000);
    const b = { id: randomUUID(), tabId: "tab", startMs: start, endMs: start + 5000 };
    expect(recordPracticeActivity(env.db, env.deps, s, b)).toEqual({ recorded: true });
    expect(recordPracticeActivity(env.db, env.deps, s, b)).toEqual({ recorded: false });
    expect(() => recordPracticeActivity(env.db, env.deps, s, { ...b, endMs: b.endMs - 1 })).toThrow(/already used/);
    expect(() => recordPracticeActivity(env.db, env.deps, s, { ...b, id: randomUUID() })).toThrow(/overlaps/);
    expect(env.db.prepare("SELECT count(*) AS n FROM attempts").get()).toEqual({ n: 0 });
    expect(env.db.pragma("foreign_key_check")).toEqual([]);
    expect(() => env.db.prepare("DELETE FROM practice_activity_intervals").run()).toThrow(/immutable/);
  });
  it("rejects missing lease, diagnostics, future and excessively long intervals", () => {
    const s = makeSession(env), start = env.clock.current.getTime(); advance(env, 20000);
    const b = { id: randomUUID(), tabId: "tab", startMs: start, endMs: start + 5000 };
    expect(() => recordPracticeActivity(env.db, env.deps, s, b)).toThrow(/lease/);
    takeLease(env.db, env.deps, s, "tab");
    expect(() => recordPracticeActivity(env.db, env.deps, s, { ...b, endMs: start + 20000 })).toThrow(/Invalid/);
    const d = makeSession(env, { purpose: "diagnostic" });
    expect(() => recordPracticeActivity(env.db, env.deps, d, b)).toThrow(/practice/);
  });
  it("accepts the client HTTP payload and deduplicates a retry", async () => {
    const s = makeSession(env); takeLease(env.db, env.deps, s, "tab"); const start = env.clock.current.getTime(); advance(env, 5000);
    const a = Fastify(); registerErrorHandling(a); registerSessionRoutes(a, env.db, env.deps);
    try {
      const payload = { id: randomUUID(), tabId: "tab", startMs: start, endMs: start + 5000 };
      const send = () => a.inject({ method: "POST", url: `/api/v1/sessions/${s}/activity`, payload });
      expect((await send()).json()).toEqual({ recorded: true });
      expect((await send()).json()).toEqual({ recorded: false });
    } finally { await a.close(); }
  });
  it("keeps vocabulary intervals identifiable without copying category into raw events", () => {
    const s = makeSession(env); env.db.prepare("INSERT INTO vocabulary_sessions(session_id,created_at) VALUES (?,?)").run(s,env.clock.current.toISOString()); takeLease(env.db, env.deps, s, "tab");
    const t = env.clock.current.getTime(); advance(env, 5000);
    recordPracticeActivity(env.db, env.deps, s, { id: randomUUID(), tabId: "tab", startMs: t, endMs: t + 5000 });
    expect(env.db.prepare("SELECT COUNT(*) AS n FROM practice_activity_intervals i JOIN vocabulary_sessions v ON v.session_id=i.session_id").get()).toEqual({ n: 1 });
  });
});
