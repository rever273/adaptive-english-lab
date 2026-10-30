import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AttemptResponseSchema,
  CurrentSessionResponseSchema,
  DashboardSchema,
  ErrorEnvelopeSchema,
  FeedbackResponseSchema,
  LeaseResponseSchema,
  RevealResponseSchema,
  SessionBootstrapSchema,
  SessionSnapshotSchema,
  SessionSummarySchema,
  CreateSessionResponseSchema,
} from "../../../packages/contracts/src/index.js";
import { buildApp } from "../../../apps/server/src/app.js";
import { testConfig } from "../helpers.js";
import { buildSliceTemplate, disposeSliceTemplate, openSliceCopy, type SliceEnv } from "./slice-fixture.js";

const PORT = 4318;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let env: SliceEnv;
let app: FastifyInstance;
let cookie = "";
let csrf = "";

beforeAll(() => {
  buildSliceTemplate();
}, 180_000);
afterAll(() => disposeSliceTemplate());
beforeEach(async () => {
  env = openSliceCopy();
  app = await buildApp({
    config: testConfig(env.root, PORT),
    db: env.db,
    instanceId: "i",
    startedAt: "2026-01-01T00:00:00Z",
    shutdownToken: "t",
    onShutdown: () => {},
    csrfSecret: Buffer.alloc(32, 9),
    attempts: { now: env.deps.now, newId: randomUUID }, // the DEFAULT closed-form grader is used
    sessions: { banner: "Non-release slice" },
  });
  const boot = await app.inject({ method: "GET", url: "/api/v1/session", headers: { host: HOST } });
  csrf = SessionBootstrapSchema.parse(boot.json()).csrfToken;
  cookie = String(boot.headers["set-cookie"]).split(";")[0]!;
});
afterEach(async () => {
  await app.close();
  env.cleanup();
});

const get = (url: string) => app.inject({ method: "GET", url, headers: { host: HOST } });
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: "POST", url, payload: payload as object, headers: { host: HOST, origin: ORIGIN, cookie, "x-csrf-token": csrf, ...headers } });
const start = async (seed = "http") => CreateSessionResponseSchema.parse((await post("/api/v1/sessions", { purpose: "practice", blueprintRevisionId: env.blueprintRevisionId, seed })).json());

describe("the whole practice flow over HTTP", () => {
  it("dashboard -> start -> lease -> reveal -> answer -> feedback -> continue -> finish, with contract shapes and no leaks", async () => {
    const dash = DashboardSchema.parse((await get("/api/v1/dashboard")).json());
    expect(dash).toMatchObject({ activeSessionId: null, taskCount: 18, banner: "Non-release slice" });
    expect(dash.blueprints[0]).toMatchObject({ key: "slice-everyday-mix", readySessions: 2 });
    expect(CurrentSessionResponseSchema.parse((await get("/api/v1/sessions/current")).json())).toEqual({ session: null });

    const created = await post("/api/v1/sessions", { purpose: "practice", blueprintRevisionId: env.blueprintRevisionId, seed: "http" });
    expect(created.statusCode).toBe(201);
    const { sessionId, snapshot } = CreateSessionResponseSchema.parse(created.json());
    expect(snapshot.taskCount).toBe(18);
    expect(CurrentSessionResponseSchema.parse((await get("/api/v1/sessions/current")).json()).session?.sessionId).toBe(sessionId);

    const lease = LeaseResponseSchema.parse((await post(`/api/v1/sessions/${sessionId}/lease`, { tabId: "tab-a" })).json());
    expect(lease).toMatchObject({ leaseToken: 1, heartbeatSeconds: 15 });
    const taken = await post(`/api/v1/sessions/${sessionId}/lease`, { tabId: "tab-b" });
    expect(taken.statusCode).toBe(409);
    expect(ErrorEnvelopeSchema.parse(taken.json()).error.code).toBe("LEASE_HELD");

    const slot = snapshot.slots.find((s) => s.format === "choose_form")!;
    const revealRes = await post(`/api/v1/sessions/${sessionId}/reveal`, { slotId: slot.slotId, tabId: "tab-a" });
    const revealed = RevealResponseSchema.parse(revealRes.json());
    expect(revealed.prompt.kind).toBe("choice");
    const raw = revealRes.body;
    for (const secret of ["accepted_option_ids", "explanation_ru", "hints_ru", "rubric"]) expect(raw).not.toContain(secret);

    const hint = await post(`/api/v1/sessions/${sessionId}/events`, { slotId: slot.slotId, type: "hint", clientEventId: "hint-1" });
    expect(hint.statusCode).toBe(201);
    expect(typeof hint.json().hint).toBe("string");
    expect(hint.json().hint).toMatch(/[Ѐ-ӿ]/);

    const content = JSON.parse((env.db.prepare("SELECT er.content_json AS c FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.id = ?").get(slot.slotId) as { c: string }).c);
    const att = AttemptResponseSchema.parse((await post("/api/v1/attempts", { slotId: slot.slotId, submissionId: "sub-1", answer: content.payload.accepted_option_ids, inputMode: "text" })).json());
    expect(att).toMatchObject({ firstAttempt: true, assisted: true, assessment: { verdict: "correct", confirmation: "confirmed" }, feedback: { allowed: true } });

    const fb = FeedbackResponseSchema.parse((await get(`/api/v1/sessions/${sessionId}/slots/${slot.slotId}/feedback`)).json());
    expect(fb).toMatchObject({ state: "confirmed", verdict: "correct" });

    expect((await post(`/api/v1/sessions/${sessionId}/events`, { slotId: slot.slotId, type: "continue", clientEventId: "cont-1" })).statusCode).toBe(201);
    const after = SessionSnapshotSchema.parse((await get(`/api/v1/sessions/${sessionId}`)).json());
    expect(after.progress).toEqual({ closed: 1, total: 18 });
    expect(after.slots.find((s) => s.slotId === slot.slotId)).toMatchObject({ state: "continued", attempts: 1, latest: { verdict: "correct", confirmation: "confirmed" } });

    const early = SessionSummarySchema.parse((await post(`/api/v1/sessions/${sessionId}/finish`, { mode: "ended_early" })).json());
    expect(early).toMatchObject({ status: "ended_early", counts: { assisted: 1, unanswered: 17 } });
    expect((await get("/api/v1/sessions/current")).json()).toEqual({ session: null });
  });

  it("a reload restores exactly the stored state: same snapshot, resumable reveal, no new exposure", async () => {
    const { sessionId, snapshot } = await start();
    await post(`/api/v1/sessions/${sessionId}/lease`, { tabId: "tab-a" });
    const slot = snapshot.slots[0]!;
    const first = RevealResponseSchema.parse((await post(`/api/v1/sessions/${sessionId}/reveal`, { slotId: slot.slotId, tabId: "tab-a" })).json());
    const exposures = (env.db.prepare("SELECT COUNT(*) AS n FROM exposures").get() as { n: number }).n;
    // "reload": a brand new tab reads the server snapshot and takes the lease after the old one expired
    env.clock.current = new Date(env.clock.current.getTime() + 91_000);
    const cur = CurrentSessionResponseSchema.parse((await get("/api/v1/sessions/current")).json());
    expect(cur.session?.slots[0]).toMatchObject({ slotId: slot.slotId, state: "revealed" });
    expect((await post(`/api/v1/sessions/${sessionId}/lease`, { tabId: "tab-reloaded" })).statusCode).toBe(200);
    const again = RevealResponseSchema.parse((await post(`/api/v1/sessions/${sessionId}/reveal`, { slotId: slot.slotId, tabId: "tab-reloaded" })).json());
    expect(again).toMatchObject({ alreadyRevealed: true, prompt: first.prompt });
    expect((env.db.prepare("SELECT COUNT(*) AS n FROM exposures").get() as { n: number }).n).toBe(exposures);
  });

  it("an answer submitted twice (retry after a network failure) is one attempt", async () => {
    const { sessionId, snapshot } = await start();
    await post(`/api/v1/sessions/${sessionId}/lease`, { tabId: "tab-a" });
    const slot = snapshot.slots.find((s) => s.format === "choose_form")!;
    await post(`/api/v1/sessions/${sessionId}/reveal`, { slotId: slot.slotId, tabId: "tab-a" });
    const body = { slotId: slot.slotId, submissionId: "same-sub", answer: ["c"], inputMode: "text" };
    expect((await post("/api/v1/attempts", body)).statusCode).toBe(201);
    expect((await post("/api/v1/attempts", body)).statusCode).toBe(200);
    expect((env.db.prepare("SELECT COUNT(*) AS n FROM attempts").get() as { n: number }).n).toBe(1);
  });
});

describe("errors and shortage are explicit", () => {
  it("a second start answers SESSION_ACTIVE with the id to resume", async () => {
    const { sessionId } = await start();
    const res = await post("/api/v1/sessions", { purpose: "practice", blueprintRevisionId: env.blueprintRevisionId });
    expect(res.statusCode).toBe(409);
    const env2 = ErrorEnvelopeSchema.parse(res.json());
    expect(env2.error).toMatchObject({ code: "SESSION_ACTIVE", details: { sessionId } });
  });

  it("insufficient bank: 409 CONTENT_SHORTAGE with exact deficits and a suggested N; the dashboard shows the same", async () => {
    for (const seed of ["s1", "s2"]) {
      const { sessionId, snapshot } = await start(seed);
      await post(`/api/v1/sessions/${sessionId}/lease`, { tabId: "t" });
      for (const s of snapshot.slots) {
        await post(`/api/v1/sessions/${sessionId}/reveal`, { slotId: s.slotId, tabId: "t" });
        await post(`/api/v1/sessions/${sessionId}/events`, { slotId: s.slotId, type: "skip", clientEventId: `skip-${seed}-${s.ordinal}` });
      }
      expect((await post(`/api/v1/sessions/${sessionId}/finish`, { mode: "completed" })).statusCode).toBe(200);
    }
    const res = await post("/api/v1/sessions", { purpose: "practice", blueprintRevisionId: env.blueprintRevisionId, seed: "s3" });
    expect(res.statusCode).toBe(409);
    const e = ErrorEnvelopeSchema.parse(res.json()).error;
    expect(e.code).toBe("CONTENT_SHORTAGE");
    const d = e.details as { deficits: Array<{ format: string; needed: number; available: number }>; requestedN: number; largestFeasibleN: number | null };
    expect(d.requestedN).toBe(18);
    expect(d.deficits.some((x) => x.available < x.needed)).toBe(true);
    const dash = DashboardSchema.parse((await get("/api/v1/dashboard")).json());
    expect(dash.blueprints[0]).toMatchObject({ readySessions: 0, shortage: { requestedN: 18 } });
  });

  it("every session mutation is protected by cookie + CSRF + Origin and validated strictly", async () => {
    const { sessionId } = await start();
    for (const [url, body] of [["/api/v1/sessions", { purpose: "practice" }], [`/api/v1/sessions/${sessionId}/lease`, { tabId: "x" }], [`/api/v1/sessions/${sessionId}/finish`, { mode: "ended_early" }]] as const) {
      const res = await post(url, body, { "x-csrf-token": "" });
      expect(res.statusCode, url).toBe(403);
    }
    expect((await get("/api/v1/sessions/current")).json().session.status).toBe("active"); // nothing changed
    for (const bad of [{ purpose: "practice", extra: 1 }, { purpose: "exam" }, { purpose: "practice", timezone: "" }]) {
      const res = await post("/api/v1/sessions", bad);
      expect([400, 409]).toContain(res.statusCode);
    }
    const noMode = await post(`/api/v1/sessions/${sessionId}/finish`, { mode: "done" });
    expect(noMode.statusCode).toBe(400);
    expect(ErrorEnvelopeSchema.parse(noMode.json()).error.code).toBe("VALIDATION_ERROR");
    expect((await get("/api/v1/sessions/" + randomUUID())).statusCode).toBe(404);
  });
});
