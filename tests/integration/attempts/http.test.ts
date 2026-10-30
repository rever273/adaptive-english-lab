import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AttemptResponseSchema, DisputeResponseSchema, ErrorEnvelopeSchema, SessionBootstrapSchema, SessionEventResponseSchema } from "../../../packages/contracts/src/index.js";
import { buildApp } from "../../../apps/server/src/app.js";
import { exactSetAssessor, makeEnv, one, revealedSlot, testConfigFor, type Env } from "./fixtures.js";

const PORT = 4318;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let env: Env;
let app: FastifyInstance;
let cookie = "";
let csrf = "";

beforeAll(async () => {
  env = await makeEnv({ assessor: exactSetAssessor() });
  app = await buildApp({
    config: testConfigFor(env, PORT),
    db: env.db,
    instanceId: "i",
    startedAt: "2026-01-01T00:00:00Z",
    shutdownToken: "t",
    onShutdown: () => {},
    csrfSecret: Buffer.alloc(32, 7),
    attempts: { assessor: exactSetAssessor(), now: env.deps.now, newId: randomUUID },
  });
  const boot = await app.inject({ method: "GET", url: "/api/v1/session", headers: { host: HOST } });
  csrf = SessionBootstrapSchema.parse(boot.json()).csrfToken;
  cookie = String(boot.headers["set-cookie"]).split(";")[0]!;
});
afterAll(async () => {
  await app.close();
  env.cleanup();
});

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload: payload as object, headers: { host: HOST, origin: ORIGIN, cookie, "x-csrf-token": csrf, ...headers } });

describe("session bootstrap and CSRF for mutations", () => {
  it("sets an HttpOnly SameSite=Strict cookie and a csrf token that only fits that cookie", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/session", headers: { host: HOST } });
    const sc = String(res.headers["set-cookie"]);
    expect(sc).toMatch(/el_sid=[0-9a-f]+\.[0-9a-f]+/);
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Strict");
    const again = await app.inject({ method: "GET", url: "/api/v1/session", headers: { host: HOST, cookie: sc.split(";")[0]! } });
    expect(again.headers["set-cookie"]).toBeUndefined(); // valid cookie is kept
    expect(again.json().csrfToken).toBe(res.json().csrfToken);
  });

  it.each([
    ["no cookie, no token", { cookie: "", "x-csrf-token": "" }],
    ["cookie but no token", { "x-csrf-token": "" }],
    ["token of another cookie", { "x-csrf-token": "0".repeat(64) }],
    ["forged cookie", { cookie: "el_sid=abc.def" }],
  ])("rejects a mutation with %s", async (_n, headers) => {
    const { slotId } = revealedSlot(env);
    const res = await post("/api/v1/attempts", { slotId, submissionId: randomUUID(), answer: ["a"], inputMode: "text" }, headers);
    expect(res.statusCode).toBe(403);
    expect(ErrorEnvelopeSchema.parse(res.json()).error.code).toBe("CSRF_FAILED");
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM attempts WHERE slot_id = ?", slotId).n).toBe(0);
  });

  it("requires an Origin on mutations and rejects a foreign one", async () => {
    const noOrigin = await app.inject({ method: "POST", url: "/api/v1/attempts", payload: {}, headers: { host: HOST, cookie, "x-csrf-token": csrf } });
    expect(noOrigin.statusCode).toBe(403);
    expect(ErrorEnvelopeSchema.parse(noOrigin.json()).error.code).toBe("ORIGIN_REQUIRED");
    const evil = await post("/api/v1/attempts", {}, { origin: "https://evil.example" });
    expect(evil.statusCode).toBe(403);
    expect(ErrorEnvelopeSchema.parse(evil.json()).error.code).toBe("FORBIDDEN_ORIGIN");
  });
});

describe("POST /api/v1/attempts", () => {
  it("creates, then replays, then conflicts - with the contract shapes", async () => {
    const { slotId } = revealedSlot(env);
    const body = { slotId, submissionId: "sub-http-1", answer: ["a"], inputMode: "text" };
    const created = await post("/api/v1/attempts", body);
    expect(created.statusCode).toBe(201);
    const c = AttemptResponseSchema.parse(created.json());
    expect(c).toMatchObject({ attemptNo: 1, firstAttempt: true, replayed: false, assessment: { verdict: "correct" }, feedback: { allowed: true } });

    const replay = await post("/api/v1/attempts", body);
    expect(replay.statusCode).toBe(200);
    expect(AttemptResponseSchema.parse(replay.json())).toEqual({ ...c, replayed: true });

    const conflict = await post("/api/v1/attempts", { ...body, answer: ["b"] });
    expect(conflict.statusCode).toBe(409);
    expect(ErrorEnvelopeSchema.parse(conflict.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it.each([
    ["extra property", { firstAttempt: true }],
    ["client-sent hint flags", { hintsBefore: 0 }],
    ["answer and idk together", { idk: true }],
    ["neither answer nor idk", { answer: undefined }],
    ["empty text", { answer: "" }],
    ["text over 2000 chars", { answer: "x".repeat(2001) }],
    ["voice without transcript", { inputMode: "voice", answer: "text" }],
    ["transcript on text input", { transcriptId: "t1" }],
    ["duplicate option ids", { answer: ["a", "a"] }],
  ])("rejects invalid body: %s", async (_n, over) => {
    const { slotId } = revealedSlot(env);
    const res = await post("/api/v1/attempts", { slotId, submissionId: randomUUID(), answer: ["a"], inputMode: "text", ...over });
    expect(res.statusCode).toBe(400);
    expect(ErrorEnvelopeSchema.parse(res.json()).error.code).toBe("VALIDATION_ERROR");
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM attempts WHERE slot_id = ?", slotId).n).toBe(0);
  });

  it("maps domain errors into the error envelope", async () => {
    const res = await post("/api/v1/attempts", { slotId: randomUUID(), submissionId: randomUUID(), answer: ["a"], inputMode: "text" });
    expect(res.statusCode).toBe(404);
    expect(ErrorEnvelopeSchema.parse(res.json()).error).toMatchObject({ code: "SLOT_NOT_FOUND", details: null });
  });
});

describe("POST /api/v1/sessions/:id/events and /assessments/:id/dispute", () => {
  it("records hint -> attempt -> dispute through the API", async () => {
    const { sessionId, slotId } = revealedSlot(env);
    const hint = await post(`/api/v1/sessions/${sessionId}/events`, { slotId, type: "hint", clientEventId: "ce-1" });
    expect(hint.statusCode).toBe(201);
    expect(SessionEventResponseSchema.parse(hint.json())).toMatchObject({ type: "hint", replayed: false });
    expect((await post(`/api/v1/sessions/${sessionId}/events`, { slotId, type: "hint", clientEventId: "ce-1" })).statusCode).toBe(200);
    expect((await post(`/api/v1/sessions/${sessionId}/events`, { slotId, type: "reveal", clientEventId: "ce-x" })).statusCode).toBe(400); // reveal has its own endpoint

    const att = AttemptResponseSchema.parse((await post("/api/v1/attempts", { slotId, submissionId: randomUUID(), answer: ["a"], inputMode: "text" })).json());
    expect(att.assisted).toBe(true);

    const dispute = await post(`/api/v1/assessments/${att.assessment.id}/dispute`, { reason: "I disagree" });
    expect(dispute.statusCode).toBe(201);
    expect(DisputeResponseSchema.parse(dispute.json()).assessment).toMatchObject({ sequence: 2, verdict: "disputed" });
    const stale = await post(`/api/v1/assessments/${att.assessment.id}/dispute`, { reason: "again" });
    expect(stale.statusCode).toBe(409);
    expect(ErrorEnvelopeSchema.parse(stale.json()).error.code).toBe("STALE_ASSESSMENT");
    expect((await post(`/api/v1/assessments/${att.assessment.id}/dispute`, { reason: "" })).statusCode).toBe(400);
  });
});
