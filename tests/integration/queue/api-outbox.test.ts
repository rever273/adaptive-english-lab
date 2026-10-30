import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema, SessionBootstrapSchema } from "../../../packages/contracts/src/index.js";
import { buildApp } from "../../../apps/server/src/app.js";
import { recordAttempt } from "../../../apps/server/src/domain/attempts/attempts.js";
import { ClosedFormAssessor } from "../../../apps/server/src/domain/content/grader.js";
import { enqueue, getJob } from "../../../apps/server/src/queue/jobs.js";
import { jobsOutbox } from "../../../apps/server/src/queue/outbox.js";
import { GpuScheduler } from "../../../apps/server/src/queue/scheduler.js";
import { fixture, uniq } from "../../fixtures/exercises/load.js";
import { FakeClock, FakeGpu, FakeRunner, flush } from "../../fixtures/queue/fakes.js";
import { makeEnv, makeRevision, makeSession, makeSlot, addEvent, one, rows, type Env } from "../attempts/fixtures.js";
import { freePort, testConfig } from "../helpers.js";

let env: Env;
let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
  env?.cleanup();
});

describe("the real outbox: raw answer, pending assessment and the queued analysis job commit together", () => {
  const guidedSlot = (content = fixture("guided_short_answer")) => {
    const rev = makeRevision(env, { type: "guided_short_answer", dimension: "production", content });
    const session = makeSession(env);
    const slotId = makeSlot(env, session, rev, 0);
    addEvent(env, session, slotId, "reveal");
    return slotId;
  };

  it("an unapproved free-text answer enqueues exactly one analysis job (idempotent per attempt) and stays pending", async () => {
    env = await makeEnv({ assessor: ClosedFormAssessor });
    const deps = { ...env.deps, outbox: jobsOutbox({ now: env.deps.now, newId: randomUUID }) };
    const slotId = guidedSlot();
    const r = recordAttempt(env.db, deps, { slotId, submissionId: "s1", answer: "He quit it long ago.", inputMode: "text" });
    expect(r.body.assessment).toMatchObject({ verdict: "pending" });
    const job = rows<{ id: string; kind: string; state: string; priority: number; payload_json: string; idempotency_key: string }>(env.db, "SELECT * FROM jobs");
    expect(job).toHaveLength(1);
    expect(job[0]).toMatchObject({ kind: "free_text_analysis", state: "queued", priority: 1, idempotency_key: `free_text_analysis:${r.body.attemptId}` });
    expect(JSON.parse(job[0]!.payload_json)).toMatchObject({ attemptId: r.body.attemptId, assessmentId: r.body.assessment.id });
    // the replay of the same submission neither duplicates the attempt nor the job
    expect(recordAttempt(env.db, deps, { slotId, submissionId: "s1", answer: "He quit it long ago.", inputMode: "text" }).status).toBe(200);
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM jobs").n).toBe(1);
  });

  it("an approved alternative needs no job; a failing queue insert rolls the attempt back", async () => {
    env = await makeEnv({ assessor: ClosedFormAssessor });
    const deps = { ...env.deps, outbox: jobsOutbox({ now: env.deps.now, newId: randomUUID }) };
    const slotId = guidedSlot();
    recordAttempt(env.db, deps, { slotId, submissionId: "ok", answer: "The employee stopped checking emails after the shift.", inputMode: "text" });
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM jobs").n).toBe(0);

    const bad = guidedSlot(uniq("guided_short_answer", "Other"));
    env.db.exec("CREATE TRIGGER block_jobs BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'queue down'); END");
    expect(() => recordAttempt(env.db, deps, { slotId: bad, submissionId: "x", answer: "Totally different.", inputMode: "text" })).toThrow(/queue down/);
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM attempts WHERE submission_id = 'x'").n).toBe(0);
  });
});

describe("jobs / gpu / actions / events API", () => {
  let port: number;
  let cookie = "";
  let csrf = "";
  let sched: GpuScheduler;
  let runner: FakeRunner;
  let clock: FakeClock;

  const boot = async () => {
    env = await makeEnv();
    port = await freePort();
    clock = new FakeClock();
    const gpu = new FakeGpu(clock);
    runner = new FakeRunner("test_unit", gpu);
    sched = new GpuScheduler({ db: env.db, newId: randomUUID, clock, telemetry: gpu, control: gpu, runners: [runner], instanceId: "api", config: { admission: "spike" } });
    app = await buildApp({ config: testConfig(env.scratch.root, port), db: env.db, instanceId: "i", startedAt: "2026-01-01T00:00:00Z", shutdownToken: "t", onShutdown: () => {}, csrfSecret: Buffer.alloc(32, 5), attempts: { now: () => clock.now(), newId: randomUUID }, scheduler: sched });
    const res = await app.inject({ method: "GET", url: "/api/v1/session", headers: { host: `127.0.0.1:${port}` } });
    csrf = SessionBootstrapSchema.parse(res.json()).csrfToken;
    cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  };
  const host = () => `127.0.0.1:${port}`;
  const get = (url: string) => app!.inject({ method: "GET", url, headers: { host: host() } });
  const post = (url: string, payload: unknown, h: Record<string, string> = {}) => app!.inject({ method: "POST", url, payload: payload as object, headers: { host: host(), origin: `http://${host()}`, cookie, "x-csrf-token": csrf, ...h } });
  const deps = () => ({ now: () => clock.now(), newId: randomUUID });

  it("lists jobs with counted progress (never a fake percentage) and reports the GPU honestly", async () => {
    await boot();
    const j = enqueue(env.db, deps(), { kind: "generation", payload: {}, idempotencyKey: "g1" }).job;
    env.db.prepare("UPDATE jobs SET checkpoint_json = ? WHERE id = ?").run(JSON.stringify({ done: 3, total: 10 }), j.id);
    const list = (await get("/api/v1/jobs")).json() as { jobs: Array<{ id: string; kind: string; state: string; progress: { done: number; total: number } | null; hasResult: boolean }> };
    expect(list.jobs).toHaveLength(1);
    expect(list.jobs[0]).toMatchObject({ id: j.id, kind: "generation", state: "queued", progress: { done: 3, total: 10 }, hasResult: false });
    expect((await get("/api/v1/jobs?state=nonsense")).statusCode).toBe(400);
    expect(((await get("/api/v1/jobs?state=completed")).json() as { jobs: unknown[] }).jobs).toEqual([]);

    const gpu = (await get("/api/v1/gpu")).json() as { available: boolean; owner: string | null; reserveMib: number; telemetry: { totalMib: number } | string; waitingByReason: Record<string, number> };
    expect(gpu).toMatchObject({ available: true, owner: null, reserveMib: 2048 });
    expect(typeof gpu.telemetry).toBe("object");
  });

  it("actions are CSRF-protected, follow the state machine and answer illegal ones with 409", async () => {
    await boot();
    const j = enqueue(env.db, deps(), { kind: "test_unit", payload: {}, idempotencyKey: "a1" }).job;
    expect((await post(`/api/v1/jobs/${j.id}/actions`, { action: "pause" }, { "x-csrf-token": "" })).statusCode).toBe(403);
    expect(getJob(env.db, j.id)!.state).toBe("queued");
    const paused = await post(`/api/v1/jobs/${j.id}/actions`, { action: "pause" });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ state: "paused" });
    const illegal = await post(`/api/v1/jobs/${j.id}/actions`, { action: "retry" });
    expect(illegal.statusCode).toBe(409);
    expect(ErrorEnvelopeSchema.parse(illegal.json()).error.code).toBe("ILLEGAL_TRANSITION");
    expect((await post(`/api/v1/jobs/${j.id}/actions`, { action: "explode" })).statusCode).toBe(400);
    expect((await post(`/api/v1/jobs/${randomUUID()}/actions`, { action: "pause" })).statusCode).toBe(404);
    expect((await post(`/api/v1/jobs/${j.id}/actions`, { action: "cancel" })).json()).toMatchObject({ state: "cancelled" });
  });

  it("the API says so when no scheduler runs", async () => {
    env = await makeEnv();
    port = await freePort();
    app = await buildApp({ config: testConfig(env.scratch.root, port), db: env.db, instanceId: "i", startedAt: "2026-01-01T00:00:00Z", shutdownToken: "t", onShutdown: () => {} });
    const res = await app.inject({ method: "GET", url: "/api/v1/gpu", headers: { host: `127.0.0.1:${port}` } });
    expect(res.json()).toEqual({ available: false, reason: "scheduler_not_running" });
  });

  it("SSE replays persisted state changes from Last-Event-ID and follows new ones", async () => {
    await boot();
    await app!.listen({ host: "127.0.0.1", port });
    const a = enqueue(env.db, deps(), { kind: "test_unit", payload: {}, idempotencyKey: "s1" }).job;
    const ctl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/events`, { headers: { "Last-Event-ID": "0", Accept: "text/event-stream" }, signal: ctl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const readUntil = async (needle: string) => {
      for (let i = 0; i < 20 && !text.includes(needle); i++) {
        const { value } = await reader.read();
        text += dec.decode(value);
      }
    };
    await readUntil(a.id);
    expect(text).toContain("event: job");
    expect(text).toContain('"state":"queued"');
    expect(text).toMatch(/id: \d+/);
    const lastId = Number(/id: (\d+)/.exec(text)![1]);
    // a later change arrives through the same stream
    env.db.prepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").run(a.id);
    env.db.prepare("INSERT INTO job_events(id, job_id, sequence, state, reason, created_at) VALUES (?,?,?,?,?,?)").run(randomUUID(), a.id, 2, "cancelled", "test", "now");
    await readUntil('"state":"cancelled"');
    expect(text).toContain('"state":"cancelled"');
    ctl.abort();
    // reconnecting with the last id replays nothing old
    const ctl2 = new AbortController();
    const again = await fetch(`http://127.0.0.1:${port}/api/v1/events`, { headers: { "Last-Event-ID": String(lastId + 1) }, signal: ctl2.signal });
    const r2 = again.body!.getReader();
    const first = dec.decode((await r2.read()).value);
    expect(first).toContain("retry:");
    ctl2.abort();
    await flush();
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
