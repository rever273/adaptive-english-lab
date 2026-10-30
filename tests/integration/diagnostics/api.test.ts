import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DashboardSchema, ErrorEnvelopeSchema, SessionBootstrapSchema } from "../../../packages/contracts/src/index.js";
import { buildApp } from "../../../apps/server/src/app.js";
import { ClosedFormAssessor } from "../../../apps/server/src/domain/content/grader.js";
import { freePort, testConfig } from "../helpers.js";
import { diagEnv, slotsOf } from "./fixtures.js";
import type { Env } from "../attempts/fixtures.js";

let env: Env | null = null;
let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
  env?.cleanup();
  env = null;
});

async function boot() {
  const x = await diagEnv({ diagnostic: true });
  env = x.env;
  const port = await freePort();
  app = await buildApp({ config: testConfig(env.scratch.root, port), db: env.db, instanceId: "i", startedAt: "2026-01-01T00:00:00Z", shutdownToken: "t", onShutdown: () => {}, csrfSecret: Buffer.alloc(32, 5), attempts: { now: env.deps.now, newId: randomUUID, assessor: ClosedFormAssessor } as never });
  const host = `127.0.0.1:${port}`;
  const b = await app.inject({ method: "GET", url: "/api/v1/session", headers: { host } });
  const csrf = SessionBootstrapSchema.parse(b.json()).csrfToken;
  const cookie = String(b.headers["set-cookie"]).split(";")[0]!;
  return {
    get: (u: string) => app!.inject({ method: "GET", url: u, headers: { host } }),
    post: (u: string, body: unknown) => app!.inject({ method: "POST", url: u, payload: body as object, headers: { host, origin: `http://${host}`, cookie, "x-csrf-token": csrf } }),
  };
}

describe("diagnostic and held-out over HTTP", () => {
  it("the dashboard offers the optional blocks honestly; a block is created, resumable, and refuses a second one while open", async () => {
    const api = await boot();
    const dash = DashboardSchema.parse((await api.get("/api/v1/dashboard")).json());
    expect(dash.diagnostic).toMatchObject({ protocol: "diagnostic-v1", blocksTotal: 3, blocksUsed: 0, nextBlock: 1, ready: true, shortage: null });
    expect(dash.heldout).toMatchObject({ ready: false, reason: "no_skill_practised_for_7_days" });

    const res = await api.post("/api/v1/sessions", { purpose: "diagnostic" });
    expect(res.statusCode).toBe(201);
    const snap = (res.json() as { sessionId: string; snapshot: { purpose: string; slots: unknown[]; progress: { total: number } } });
    expect(snap.snapshot).toMatchObject({ purpose: "diagnostic", progress: { total: 8 } });
    expect(snap.snapshot.slots).toHaveLength(8);

    const again = await api.post("/api/v1/sessions", { purpose: "diagnostic" });
    expect(again.statusCode).toBe(409);
    expect(ErrorEnvelopeSchema.parse(again.json()).error.code).toBe("SESSION_ACTIVE");
    // resume: the current session is the same block with the same tasks
    const cur = (await api.get("/api/v1/sessions/current")).json() as { session: { sessionId: string; purpose: string } };
    expect(cur.session).toMatchObject({ sessionId: snap.sessionId, purpose: "diagnostic" });

    // hints are closed over the wire as well (reveal first, as the page does)
    const slots = slotsOf(env!, snap.sessionId);
    expect((await api.post(`/api/v1/sessions/${snap.sessionId}/lease`, { tabId: "t1" })).statusCode).toBe(200);
    expect((await api.post(`/api/v1/sessions/${snap.sessionId}/reveal`, { slotId: slots[0]!.slot_id, tabId: "t1" })).statusCode).toBe(200);
    const hint = await api.post(`/api/v1/sessions/${snap.sessionId}/events`, { slotId: slots[0]!.slot_id, type: "hint", clientEventId: randomUUID() });
    expect(hint.statusCode).toBe(409);
    expect(ErrorEnvelopeSchema.parse(hint.json()).error.code).toBe("HINTS_CLOSED");

    expect((await api.post(`/api/v1/sessions/${snap.sessionId}/finish`, { mode: "ended_early" })).statusCode).toBe(200);
    const held = await api.post("/api/v1/sessions", { purpose: "heldout" });
    expect(held.statusCode).toBe(409);
    expect(ErrorEnvelopeSchema.parse(held.json()).error.code).toBe("HELDOUT_NOT_READY");
    expect((await api.post("/api/v1/sessions", { purpose: "diagnostic", blueprintRevisionId: "x", extra: 1 })).statusCode).toBe(400);
  });
});
