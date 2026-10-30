// npm run benchmark:ai -- --manifest documentation/spec/benchmark-cases.json
// REAL model benchmark (TASK_009) on the installed Ollama models, run through the single GPU dispatcher (one unit at a time).
// Protocol: spec/BENCHMARK.md. Gold labels are the architect's pending_review labels (+ one agent review pass): the numbers below are
// MEASUREMENTS, not an accuracy claim, until two independent adjudication passes exist. Nothing is downloaded; only models this run
// loads are unloaded; it refuses to start when another model is resident.
//   usage: node scripts/benchmark-ai.mjs --manifest <file> [--models a,b,c] [--runs 3] [--cold 5] [--out <dir>]
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync } from "node:fs";
import path from "node:path";
import { loadServerModule, projectRoot, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const manifestPath = path.resolve(arg("--manifest", path.join(projectRoot, "documentation", "spec", "benchmark-cases.json")));
const MODELS = arg("--models", "nimble-v3:latest,qwen3:8b").split(",");
const RUNS = Number(arg("--runs", "3"));
const SPLIT = arg("--split", "all");
const LIMIT = Number(arg("--limit", "0"));
if (!["all","development","heldout"].includes(SPLIT) || !Number.isInteger(RUNS) || RUNS < 1 || RUNS > 3 || !Number.isInteger(LIMIT) || LIMIT < 0) throw new Error("invalid benchmark arguments");
if (MODELS.some(m => !["nimble-v3:latest", "qwen3:8b"].includes(m))) throw new Error("Only the two authorised installed models are allowed (qwen3:14b excluded by user)");
const COLD = Number(arg("--cold", "5"));
const OUT = path.resolve(arg("--out", path.join(projectRoot, "documentation", "spec", "evidence", "task-009")));
mkdirSync(OUT, { recursive: true });

const sha = (b) => createHash("sha256").update(b).digest("hex");
const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const cases = manifest.cases.filter(c => SPLIT === "all" || c.split === SPLIT).slice(0, LIMIT || undefined).map((c) => ({ id: c.id, group: c.group, topic: c.topic, text: c.text, expected: c.expected, skill_id: c.skill_id, split: c.split }));
const taxonomy = JSON.parse(readFileSync(path.join(projectRoot, "content", "taxonomy", "taxonomy-v1.json"), "utf8"));
const allowedSkillIds = taxonomy.skills.map((s) => s.id);
const splitHash = sha(JSON.stringify(cases.map((c) => [c.id, c.split])));

const { openDatabase } = await loadServerModule("db/open.js");
const { runMigrations } = await loadServerModule("db/migrate.js");
const { GpuScheduler } = await loadServerModule("queue/scheduler.js");
const jobs = await loadServerModule("queue/jobs.js");
const { NvidiaSmiTelemetry } = await loadServerModule("adapters/gpu/nvidiaSmi.js");
const { OllamaClient, OllamaModelControl } = await loadServerModule("adapters/gpu/ollamaClient.js");
const { OllamaChatClient, NimbleDecisionClient } = await loadServerModule("adapters/ollama/chat.js");
const { BenchmarkRunner } = await loadServerModule("domain/ai/benchmarkRunner.js");
const bench = await loadServerModule("domain/ai/benchmark.js");
const prompts = await loadServerModule("domain/ai/prompts.js");
const validate = await loadServerModule("domain/ai/validate.js");
const aiConfig = await loadServerModule("domain/ai/config.js");

const telemetry = new NvidiaSmiTelemetry();
const client = new OllamaClient();
const control = new OllamaModelControl(client);
const version = await client.json("/api/version", { method: "GET", timeoutMs: 5000 });
const tags = await client.json("/api/tags", { method: "GET", timeoutMs: 5000 });
const loaded0 = await control.listLoaded();
if (loaded0 === null || loaded0.length > 0) {
  console.error(`Refusing to run: Ollama unreachable or models resident (${JSON.stringify(loaded0)}). Ollama in use.`);
  process.exit(2);
}
const base = await telemetry.sample();
if (!base) throw new Error("nvidia-smi telemetry unavailable");

const runStamp = new Date().toISOString().replace(/[-:.]/g, "");
const dir = path.join(projectRoot, "var", "bench", `repair-${runStamp}-${randomUUID().slice(0,8)}`);
const lockPath = path.join(projectRoot, "var", "run", "benchmark.lock");
mkdirSync(path.dirname(lockPath), {recursive:true});
if (existsSync(path.join(projectRoot,"var","run","server.lock.json"))) throw new Error("Server lock exists; refuse an independent benchmark scheduler");
const lockFd = openSync(lockPath,"wx");
writeFileSync(lockFd, JSON.stringify({pid:process.pid, startedAt:new Date().toISOString()}));
process.on("exit",()=>{try {closeSync(lockFd);unlinkSync(lockPath);} catch {}});
const db = openDatabase(path.join(dir, "db", "bench.sqlite"));
await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "benchmark-ai" });
const deps = { now: () => new Date(), newId: randomUUID };
const runner = new BenchmarkRunner({ chat: new OllamaChatClient(client), decision: new NimbleDecisionClient(client) });
const sched = new GpuScheduler({ db, newId: randomUUID, telemetry, control, runners: [runner], instanceId: "benchmark-ai", config: { admission: "spike", idleUnloadMs: 30 * 60_000 } });

let phase = "idle";
const samples = [];
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    const s = await telemetry.sample();
    if (s) samples.push({ t: Date.now(), usedMib: s.usedMib, phase });
    await new Promise((r) => setTimeout(r, 250));
  }
})();
const peakIn = (p) => Math.max(0, ...samples.filter((s) => s.phase === p).map((s) => s.usedMib));

// deterministic order (seed fixed and recorded)
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ORDER_SEED = 20261028;
const rnd = mulberry32(ORDER_SEED);
const order = [...cases].sort((a, b) => a.id.localeCompare(b.id)).map((c) => [rnd(), c]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);

async function runJob(payload, key) {
  const j = jobs.enqueue(db, deps, { kind: "benchmark", payload, idempotencyKey: key }).job;
  sched.kick();
  for (;;) {
    const cur = jobs.getJob(db, j.id);
    if (cur.state === "completed") {
      const res = jobs.resultOf(db, j.id).output;
      return { job: cur, results: res.results };
    }
    if (cur.state === "failed" || cur.state === "cancelled") throw new Error(`job ${key} ${cur.state}: ${cur.errorCode}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const out = { startedAt: new Date().toISOString(), workDir: path.relative(projectRoot, dir), scope: {split:SPLIT,limit:LIMIT}, qualification: {qualified:false, reason:"Exploratory regression set, previously inspected labels pending independent adjudication; point gate is not production qualification."}, manifest: { path: path.relative(projectRoot, manifestPath), sha256: sha(manifestBytes), status: manifest.status, cases: cases.length, splitHash, orderSeed: ORDER_SEED }, environment: { ollama: version, baselineUsedMib: base.usedMib, totalMib: base.totalMib, node: process.version }, prompts: { analysis: sha(prompts.ANALYSIS_SYSTEM_V3), triage: sha(prompts.TRIAGE_SYSTEM_V1), triageV3: sha(prompts.PROMPTS["triage-v3"].template), analysisSchema: sha(JSON.stringify(validate.schemaVariant("analysis-v2"))) }, config: aiConfig.AI_CONFIG_V2.analysis, models: {} };
sched.start(200);
try {
  for (const model of MODELS) {
    const expectedDigest = model.startsWith("nimble") ? aiConfig.AI_CONFIG_V2.triage.digest : aiConfig.AI_CONFIG_V2.analysis.digest;
    const tag = tags.models.find((m) => m.name === model);
    if (!tag) {
      out.models[model] = { skipped: "not installed (nothing is downloaded)" };
      continue;
    }
    if (tag.digest !== expectedDigest) throw new Error(`Pinned digest drift for ${model}`);
    const capability = model.startsWith("nimble") ? "triage" : "analysis";
    const entry = { digest: tag.digest, capability, cold: [], warmPasses: [] };
    out.models[model] = entry;
    console.log(`== ${model} (${capability}) ${tag.digest.slice(0, 12)}`);

    // cold trials: unload (proven), then one short request; queue wait is reported apart from execution
    const coldCases = [...cases].filter((c) => c.split === "development").slice(0, COLD);
    for (let i = 0; i < COLD; i++) {
      await sched.verifiedRelease([model]);
      phase = `${model}:cold${i}`;
      const t0 = Date.now();
      const { job, results } = await runJob({ model, capability, phase: "cold", run: 0, cases: [coldCases[i % coldCases.length]], allowedSkillIds }, `cold:${model}:${i}`);
      const wall = Date.now() - t0;
      entry.cold.push({ trial: i, wallMs: wall, queueWaitMs: Date.parse(job.startedAt) - Date.parse(job.createdAt), executionMs: results[0].latencyMs, loadMs: results[0].loadMs, peakUsedMib: peakIn(phase) });
      console.log(" cold", i, JSON.stringify(entry.cold.at(-1)));
    }
    // warm passes over all 60 cases (pass 0 is the scored pass; passes 1..n-1 measure stability and give >= 20 repeated warm samples)
    for (let r = 0; r < RUNS; r++) {
      phase = `${model}:warm${r}`;
      const t0 = Date.now();
      const { job, results } = await runJob({ model, capability, phase: "warm", run: r, cases: order, allowedSkillIds }, `warm:${model}:${r}`);
      entry.warmPasses.push({ run: r, wallMs: Date.now() - t0, queueWaitMs: Date.parse(job.startedAt) - Date.parse(job.createdAt), peakUsedMib: peakIn(phase), results });
      writeFileSync(path.join(OUT,`benchmark-checkpoint-${runStamp}.json`), JSON.stringify(out,null,2));
      console.log(" warm", r, results.length, "cases", Date.now() - t0, "ms");
    }
    const scored = bench.scoreModel(model, capability, cases, entry.warmPasses[0].results);
    entry.score = scored;
    entry.scoreEveryPass = entry.warmPasses.map(p => bench.scoreModel(model,capability,cases,p.results));
    // the first warm pass includes model loading in its first case: drop it from latency
    const warmRes = entry.warmPasses.flatMap((p, pi) => p.results.filter((_, i) => !(pi === 0 && i === 0)));
    entry.latency = bench.latencySummary(warmRes);
    entry.stability = bench.stability(entry.warmPasses.map((p) => p.results));
    entry.peakUsedMib = Math.max(...entry.warmPasses.map((p) => p.peakUsedMib), ...entry.cold.map((c) => c.peakUsedMib));
    entry.peakAdditionalMib = entry.peakUsedMib - base.usedMib;
    entry.warmPass0Repeat20 = bench.latencySummary(entry.warmPasses.flatMap((p) => p.results).slice(0, 20));
    const rel = await sched.verifiedRelease([model]);
    entry.releaseProven = rel;
  }
} finally {
  sampling = false;
  await sampler;
  await sched.stop();
  writeFileSync(path.join(OUT,`benchmark-intermediate-${runStamp}.json`),JSON.stringify({...out,samples},null,1));
  db.close();
}
out.finishedAt = new Date().toISOString();
out.finalPs = await control.listLoaded();
const stamp = out.startedAt.replace(/[-:]/g, "").slice(0, 15) + "Z";
const raw = { ...out, models: Object.fromEntries(Object.entries(out.models).map(([k, v]) => [k, v])) };
writeFileSync(path.join(OUT, `benchmark-raw-${stamp}.json`), JSON.stringify(raw, null, 1));
const summary = JSON.parse(JSON.stringify(out));
for (const m of Object.values(summary.models)) for (const p of m.warmPasses ?? []) delete p.results;
writeFileSync(path.join(OUT, `benchmark-summary-${stamp}.json`), JSON.stringify(summary, null, 2));
console.log("evidence:", path.join(OUT, `benchmark-summary-${stamp}.json`));
