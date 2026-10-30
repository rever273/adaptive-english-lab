// npm run verify:gpu - REAL GPU verification of the dispatcher (TASK_008). Uses the installed Ollama + nvidia-smi on this machine.
// Controlled and bounded: one installed model (default qwen3:8b), only models THIS script loaded are unloaded, nothing is downloaded,
// and it refuses to start when another model is already resident ("Ollama in use"). Evidence goes to documentation/spec/evidence/task-008/.
//   usage: node scripts/verify-gpu.mjs [--model qwen3:8b] [--out <dir>]
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadServerModule, projectRoot, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const MODEL = arg("--model", "qwen3:8b");
const OUT = path.resolve(arg("--out", path.join(projectRoot, "documentation", "spec", "evidence", "task-008")));
mkdirSync(OUT, { recursive: true });

const { openDatabase } = await loadServerModule("db/open.js");
const { runMigrations } = await loadServerModule("db/migrate.js");
const { GpuScheduler } = await loadServerModule("queue/scheduler.js");
const jobs = await loadServerModule("queue/jobs.js");
const { NvidiaSmiTelemetry } = await loadServerModule("adapters/gpu/nvidiaSmi.js");
const { OllamaClient, OllamaModelControl } = await loadServerModule("adapters/gpu/ollamaClient.js");
const { OllamaStreamRunner } = await loadServerModule("adapters/gpu/ollamaStreamRunner.js");

const telemetry = new NvidiaSmiTelemetry();
const client = new OllamaClient();
const control = new OllamaModelControl(client);
const ev = { startedAt: new Date().toISOString(), model: MODEL, steps: [], gpuSamples: [] };
const step = (name, data = {}) => {
  ev.steps.push({ t: Date.now(), name, ...data });
  console.log(name, JSON.stringify(data));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const version = await client.json("/api/version", { method: "GET", timeoutMs: 5000 });
const tags = await client.json("/api/tags", { method: "GET", timeoutMs: 5000 });
const tag = tags.models.find((m) => m.name === MODEL);
if (!tag) throw new Error(`${MODEL} is not installed; nothing is downloaded`);
ev.ollama = version;
ev.modelDigest = tag.digest;
const loadedAtStart = await control.listLoaded();
if (loadedAtStart === null || loadedAtStart.length > 0) {
  console.error(`Refusing to run: Ollama is unreachable or has models resident (${JSON.stringify(loadedAtStart)}). Ollama in use.`);
  process.exit(2);
}
const base = await telemetry.sample();
if (!base) throw new Error("nvidia-smi telemetry unavailable");
ev.baseline = base;

// scratch database inside the project (var/ is git-ignored); never the user's data
const dir = path.join(projectRoot, "var", "gpu-verify");
rmSync(dir, { recursive: true, force: true });
const db = openDatabase(path.join(dir, "db", "verify.sqlite"));
await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "verify-gpu" });
const deps = { now: () => new Date(), newId: randomUUID };
const runner = new OllamaStreamRunner("test_unit", client, MODEL);
const sched = new GpuScheduler({ db, newId: randomUUID, telemetry, control, runners: [runner], instanceId: "verify-gpu", config: { admission: "spike", idleUnloadMs: 5 * 60_000 } });

// sample the whole card every 250 ms for the evidence file (peak VRAM, release time)
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    const s = await telemetry.sample();
    if (s) ev.gpuSamples.push({ t: Date.now(), usedMib: s.usedMib });
    await sleep(250);
  }
})();
const used = () => ev.gpuSamples.at(-1)?.usedMib ?? null;
const waitFor = async (cond, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(200);
  }
  step("timeout", { what });
  return false;
};
const stateOf = (id) => jobs.getJob(db, id).state;
const events = (id) => db.prepare("SELECT state, reason FROM job_events WHERE job_id = ? ORDER BY sequence").all(id).map((e) => `${e.state}:${e.reason}`);
const prompt = "List 150 brief, distinct, neutral example sentences about community activities. Number them.";

try {
  sched.start(500);

  // ---- A. a background unit starts, loads the model, and is preempted by practice ----
  const a = jobs.enqueue(db, deps, { kind: "test_unit", payload: { prompt, numPredict: 1200 }, idempotencyKey: "verify-a" }).job;
  const startedOk = await waitFor(async () => stateOf(a.id) === "running" && (await control.listLoaded())?.includes(MODEL) === true, 120_000, "job A running and the model listed by /api/ps (fully loaded)");
  const peakWhileRunning = Math.max(...ev.gpuSamples.map((s) => s.usedMib));
  const psRunning = await control.listLoaded();
  step("A_running", { startedOk, peakUsedMib: peakWhileRunning, loaded: psRunning, fencingToken: db.prepare("SELECT fencing_token AS t, owner_id AS o FROM gpu_lock").get() });
  await sleep(2500); // let it stream for a moment

  const t0 = Date.now();
  const practice = await sched.beginPractice();
  const teardownMs = Date.now() - t0;
  await sleep(1500);
  const psAfter = await control.listLoaded();
  const usedAfter = (await telemetry.sample())?.usedMib ?? null;
  step("A_preempted_by_practice", {
    practice,
    teardownMs,
    loadedAfter: psAfter,
    usedAfterMib: usedAfter,
    baselineMib: base.usedMib,
    returnedToBaselineWithin: usedAfter === null ? null : usedAfter - base.usedMib,
    jobState: stateOf(a.id),
    jobEvents: events(a.id),
    results: db.prepare("SELECT COUNT(*) AS n FROM job_results").get().n,
    gpuLock: db.prepare("SELECT owner_id AS o, fencing_token AS t FROM gpu_lock").get(),
  });
  // practice stays active: a new unit must NOT start on top of it
  const blocked = jobs.enqueue(db, deps, { kind: "test_unit", payload: { prompt: "Say hello.", numPredict: 20 }, idempotencyKey: "verify-blocked" }).job;
  await sleep(3000);
  step("blocked_while_practice", { state: stateOf(blocked.id), events: events(blocked.id), loaded: await control.listLoaded() });

  // ---- B. practice ends: both units resume and complete exactly once ----
  sched.endPractice();
  const done = await waitFor(() => stateOf(a.id) === "completed" && stateOf(blocked.id) === "completed", 240_000, "A and blocked completed");
  step("resumed_and_completed", {
    done,
    aEvents: events(a.id),
    blockedEvents: events(blocked.id),
    results: db.prepare("SELECT job_id, schema_version, output_hash FROM job_results").all().length,
    metricsA: jobs.resultOf(db, a.id)?.metrics,
    tokenGrows: db.prepare("SELECT fencing_token AS t FROM gpu_lock").get().t,
  });

  // ---- C. cancel of a running unit: terminal only after the proven teardown ----
  const c = jobs.enqueue(db, deps, { kind: "test_unit", payload: { prompt, numPredict: 1500 }, idempotencyKey: "verify-c" }).job;
  await waitFor(() => stateOf(c.id) === "running", 120_000, "job C running");
  await sleep(1500);
  const c0 = Date.now();
  jobs.applyAction(db, deps, c.id, "cancel");
  const stateRightAfter = stateOf(c.id);
  const cancelled = await waitFor(() => stateOf(c.id) === "cancelled", 30_000, "job C cancelled");
  step("C_cancel_running", { stateRightAfterRequest: stateRightAfter, cancelled, msToTerminal: Date.now() - c0, events: events(c.id), results: db.prepare("SELECT COUNT(*) AS n FROM job_results WHERE job_id = ?").get(c.id).n });

  // ---- D. controlled shutdown releases the model and the lease ----
  await sched.stop();
  await sleep(1500);
  step("shutdown", { loaded: await control.listLoaded(), usedMib: (await telemetry.sample())?.usedMib, baselineMib: base.usedMib, lock: db.prepare("SELECT owner_id AS o, fencing_token AS t FROM gpu_lock").get() });
} finally {
  sampling = false;
  await sampler;
  try {
    await control.unload(MODEL); // we loaded it, we release it (no-op when already gone)
  } catch {
    /* ignore */
  }
  db.close();
}
ev.peakUsedMib = Math.max(...ev.gpuSamples.map((s) => s.usedMib));
ev.finishedAt = new Date().toISOString();
ev.finalPs = await control.listLoaded();
const file = path.join(OUT, `gpu-verify-${ev.startedAt.replace(/[-:]/g, "").slice(0, 15)}Z.json`);
writeFileSync(file, JSON.stringify(ev, null, 2));
console.log("evidence:", file);
