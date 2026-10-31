// TASK_023 / D67: the one local model - residency endpoints, warm-up triggers, shutdown unload, dispatcher hand-shake, settings round trip.
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { SessionBootstrapSchema, CapabilitiesSchema, preloadModelOnStart } from "../../../packages/contracts/src/index.js";
import { buildApp } from "../../../apps/server/src/app.js";
import { enqueue, getJob } from "../../../apps/server/src/queue/jobs.js";
import { ModelResidency } from "../../../apps/server/src/queue/modelResidency.js";
import { GpuScheduler } from "../../../apps/server/src/queue/scheduler.js";
import { AI_CONFIG_V3, LOCAL_MODEL_TAG, MEASURED_ADDITIONAL_PEAK_MIB } from "../../../apps/server/src/domain/ai/config.js";
import { loadSettings } from "../../../apps/server/src/domain/sessions/policy.js";
import { deferred, FakeGpu, FakeClock, FakeDispatcher, FakeModelHost, FakeRunner, flush } from "../../fixtures/queue/fakes.js";
import { freePort, testConfig } from "../helpers.js";
import { makeEnv, type Env } from "../attempts/fixtures.js";

let env: Env | null = null;
let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
  env?.cleanup();
  env = null;
});

async function rig(opts: { withScheduler?: boolean } = {}) {
  env = await makeEnv();
  const db = env.db;
  const host = new FakeModelHost();
  const clock = new FakeClock();
  const gpu = new FakeGpu(clock);
  const runner = new FakeRunner("test_unit", gpu);
  runner.model = LOCAL_MODEL_TAG;
  const flags = { forceBusy: false };
  const sched = new GpuScheduler({ db, newId: randomUUID, clock, telemetry: gpu, control: gpu, runners: [runner], instanceId: "A", config: { admission: "spike" }, modelTransition: () => flags.forceBusy || residency.transitioning(), abortModelLoad: () => residency.abortLoad() });
  const residency = new ModelResidency({
    host,
    dispatcher: opts.withScheduler === false ? new FakeDispatcher() : sched,
    model: LOCAL_MODEL_TAG,
    numCtx: 8192,
    keepAlive: "30m",
    preloadEnabled: () => preloadModelOnStart(loadSettings(db).values),
    unloadVerifyMs: 100,
    sleep: async () => undefined,
  });
  const port = await freePort();
  app = await buildApp({
    config: testConfig(env.scratch.root, port),
    db,
    instanceId: "i",
    startedAt: "2026-01-01T00:00:00Z",
    shutdownToken: "t",
    onShutdown: () => {},
    csrfSecret: Buffer.alloc(32, 1),
    scheduler: sched,
    residency,
    aiStatus: async () => ({ ollama: "ready", model: "ready", modelTag: LOCAL_MODEL_TAG, modelState: (await residency.status()).state }),
  });
  const hostHeader = `127.0.0.1:${port}`;
  const b = await app.inject({ method: "GET", url: "/api/v1/session", headers: { host: hostHeader } });
  const csrf = SessionBootstrapSchema.parse(b.json()).csrfToken;
  const cookie = String(b.headers["set-cookie"]).split(";")[0]!;
  const call = (method: "GET" | "POST", url: string, body?: object) => app!.inject({ method, url, payload: body, headers: { host: hostHeader, origin: `http://${hostHeader}`, cookie, "x-csrf-token": csrf } });
  const bare = (url: string) => app!.inject({ method: "POST", url, headers: { host: hostHeader } });
  return { db, host, gpu, runner, sched, residency, call, bare, clock, flags };
}
const settle = () => new Promise((r) => setTimeout(r, 10));
const enqueueUnit = (t: Awaited<ReturnType<typeof rig>>, key: string) => enqueue(t.db, { now: () => t.clock.now(), newId: randomUUID }, { kind: "test_unit", payload: { key }, idempotencyKey: key }).job;

describe("model endpoints", () => {
  it("reports the state, loads in the background (202), unloads with a verified result, and shows the model in /capabilities", async () => {
    const t = await rig();
    expect((await t.call("GET", "/api/v1/ai/model")).json()).toMatchObject({ state: "unloaded", model: "gemma4:12b", preloadOnStart: true, error: null });
    t.host.loadGate = deferred();
    const load = await t.call("POST", "/api/v1/ai/model/load");
    expect(load.statusCode).toBe(202);
    expect(load.json().state).toBe("loading");
    expect(CapabilitiesSchema.parse((await t.call("GET", "/api/v1/capabilities")).json()).ai).toMatchObject({ modelTag: "gemma4:12b", modelState: "loading" });
    t.host.loadGate.resolve();
    await settle();
    expect((await t.call("GET", "/api/v1/ai/model")).json()).toMatchObject({ state: "ready", error: null });
    expect((await t.call("POST", "/api/v1/ai/model/load")).statusCode).toBe(202); // idempotent: it only confirms /api/ps
    await settle();
    expect((await t.call("GET", "/api/v1/ai/model")).json().state).toBe("ready");
    expect(t.host.loads).toBe(1);
    const un = await t.call("POST", "/api/v1/ai/model/unload");
    expect(un.statusCode).toBe(200);
    expect(un.json().state).toBe("unloaded");
    expect(t.host.resident.size).toBe(0);
  });

  it("refuses the changes without CSRF", async () => {
    const t = await rig();
    expect((await t.bare("/api/v1/ai/model/load")).statusCode).toBe(403);
    expect((await t.bare("/api/v1/ai/model/unload")).statusCode).toBe(403);
    expect(t.host.loads + t.host.unloads).toBe(0);
  });

  it("unload says 'busy' and changes nothing while a job holds the model; the job finishes normally", async () => {
    const t = await rig();
    t.runner.behaviour = "gate";
    const j = enqueueUnit(t, "k");
    await t.call("POST", "/api/v1/ai/model/load");
    await settle();
    for (let i = 0; i < 20 && getJob(t.db, j.id)!.state !== "running"; i++) {
      await t.sched.tick();
      await flush();
      t.clock.advance(500);
    }
    expect(getJob(t.db, j.id)!.state).toBe("running");
    const un = await t.call("POST", "/api/v1/ai/model/unload");
    expect(un.statusCode).toBe(409);
    expect(un.json().error.code).toBe("AI_MODEL_BUSY");
    expect(t.host.unloads).toBe(0);
    expect((await t.call("GET", "/api/v1/ai/model")).json()).toMatchObject({ state: "ready", busy: "job_running" });
    t.runner.gate(j.id).resolve();
    await t.sched.idle();
    expect(getJob(t.db, j.id)!.state).toBe("completed");
  });

  it("no unit starts on top of a load in progress; it starts when the model is ready", async () => {
    const t = await rig();
    t.host.loadGate = deferred();
    await t.call("POST", "/api/v1/ai/model/load");
    const j = enqueueUnit(t, "k2");
    for (let i = 0; i < 3; i++) {
      await t.sched.tick();
      await flush();
    }
    expect(getJob(t.db, j.id)!.state).toBe("queued");
    t.host.loadGate.resolve();
    await settle();
    for (let i = 0; i < 20 && getJob(t.db, j.id)!.state !== "completed"; i++) {
      await t.sched.tick();
      await flush();
      await flush();
      t.clock.advance(500);
    }
    expect(getJob(t.db, j.id)!.state).toBe("completed");
  });
});

describe("warm-up", () => {
  it("learner activity (dashboard, vocabulary) loads the model once in the background; polling the model endpoint does not", async () => {
    const t = await rig({ withScheduler: false });
    await t.call("GET", "/api/v1/ai/model");
    await t.call("GET", "/api/v1/capabilities");
    await settle();
    expect(t.host.loads).toBe(0);
    await t.call("GET", "/api/v1/dashboard");
    await t.call("GET", "/api/v1/vocabulary");
    await settle();
    expect(t.host.loads).toBe(1);
    expect(t.host.resident.has(LOCAL_MODEL_TAG)).toBe(true);
  });

  it("with preloadModelOnStart off nothing loads by itself - not at start, not on activity - and the setting round-trips as a new revision", async () => {
    const t = await rig({ withScheduler: false });
    const first = (await t.call("GET", "/api/v1/settings")).json();
    expect(preloadModelOnStart(first.values)).toBe(true);
    expect(JSON.parse((t.db.prepare("SELECT values_json AS v FROM settings_revisions WHERE revision = 1").get() as { v: string }).v).preloadModelOnStart).toBeUndefined();
    expect((await t.call("POST", "/api/v1/settings", { preloadModelOnStart: "yes" })).statusCode).toBe(400);
    const off = await t.call("POST", "/api/v1/settings", { preloadModelOnStart: false });
    expect(off.json().revision).toBe(2);
    expect(preloadModelOnStart(off.json().values)).toBe(false);
    t.residency.warmOnStart();
    await t.call("GET", "/api/v1/dashboard");
    await t.call("GET", "/api/v1/vocabulary");
    await settle();
    expect(t.host.loads).toBe(0);
    expect((await t.call("GET", "/api/v1/ai/model")).json()).toMatchObject({ state: "unloaded", preloadOnStart: false });
    // the manual button still works
    await t.call("POST", "/api/v1/ai/model/load");
    await settle();
    expect(t.host.loads).toBe(1);
    expect(JSON.parse((t.db.prepare("SELECT values_json AS v FROM settings_revisions WHERE revision = 1").get() as { v: string }).v).taskCount).toBe(18); // history untouched
  });

  it("start-up warm-up runs in the background when the setting is on (default)", async () => {
    const t = await rig({ withScheduler: false });
    t.residency.warmOnStart();
    await settle();
    expect(t.host.loads).toBe(1);
  });

  it("a manual unload is not undone by the next page view", async () => {
    const t = await rig({ withScheduler: false });
    await t.call("POST", "/api/v1/ai/model/load");
    await settle();
    await t.call("POST", "/api/v1/ai/model/unload");
    await t.call("GET", "/api/v1/dashboard");
    await settle();
    expect(t.host.loads).toBe(1);
    expect(t.host.resident.size).toBe(0);
  });
});

describe("dispatcher hand-shake", () => {
  it("local speech: beginPractice stops a warm-up in flight, proves the card is free and is not 'ready' before that", async () => {
    const t = await rig();
    t.host.loadGate = deferred();
    expect(t.residency.load().ok).toBe(true);
    expect(t.residency.transitioning()).toBe(true);
    const grant = await t.sched.beginPractice();
    expect(grant.ready).toBe(true);
    expect(t.residency.transitioning()).toBe(false);
    expect(t.host.resident.size).toBe(0);
    expect(t.gpu.unloads).toContain(LOCAL_MODEL_TAG); // the model that may have been half-loaded was explicitly released
    expect(t.residency.load()).toEqual({ ok: false, reason: "practice_active" });
    t.sched.endPractice();
  });

  it("the idle unload never runs while the residency service is loading/unloading", async () => {
    const t = await rig();
    t.sched.noteModelLoaded([LOCAL_MODEL_TAG]);
    t.gpu.load(LOCAL_MODEL_TAG, 100);
    t.flags.forceBusy = true;
    t.clock.advance(31 * 60_000);
    await t.sched.tick();
    expect(t.gpu.unloads).toEqual([]);
    t.flags.forceBusy = false;
    await t.sched.tick();
    expect(t.gpu.unloads).toEqual([LOCAL_MODEL_TAG]);
  });
});

describe("shutdown and the pinned model", () => {
  it("a graceful shutdown unloads the model (bounded) and nothing loads afterwards", async () => {
    const t = await rig();
    await t.call("POST", "/api/v1/ai/model/load");
    await settle();
    expect(t.host.resident.has(LOCAL_MODEL_TAG)).toBe(true);
    t.residency.halt();
    await t.sched.stop();
    await t.residency.shutdown(1000);
    expect(t.host.resident.size).toBe(0);
    expect(t.residency.load().ok).toBe(false);
  });

  it("gemma4:12b is the only pinned model, has a measured profile entry, and the server entry point starts no qwen/nimble path", () => {
    expect(MEASURED_ADDITIONAL_PEAK_MIB["gemma4:12b"]).toBe(10250);
    expect(AI_CONFIG_V3.analysis).toMatchObject({ tag: "gemma4:12b", digest: "6114515d63c17436a7c0417d82820ac65ad643e2806c5a3c89cb62846436ed0b", numCtx: 8192 });
    expect(AI_CONFIG_V3.triage.enabled).toBe(false);
    const index = readFileSync(new URL("../../../apps/server/src/index.ts", import.meta.url), "utf8");
    expect(index).not.toMatch(/qwen|nimble|AdvisoryJobRunner/i);
  });
});
