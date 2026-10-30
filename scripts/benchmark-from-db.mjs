// node scripts/benchmark-from-db.mjs [--db var/bench/db/bench.sqlite] [--models nimble-v3:latest,qwen3:8b]
// Rebuilds the benchmark summary from the job_results the benchmark run already stored in its own SQLite file. It exists because the
// run was stopped by the user before the 14b model finished (and before the script wrote its JSON); no model is called here.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { loadServerModule, projectRoot, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const dbPath = path.resolve(arg("--db", path.join(projectRoot, "var", "bench", "db", "bench.sqlite")));
const MODELS = arg("--models", "nimble-v3:latest,qwen3:8b").split(",");
const manifestPath = path.join(projectRoot, "documentation", "spec", "benchmark-cases.json");
const bytes = readFileSync(manifestPath);
const manifest = JSON.parse(bytes.toString("utf8"));
const cases = manifest.cases.map((c) => ({ id: c.id, group: c.group, topic: c.topic, text: c.text, expected: c.expected, skill_id: c.skill_id, split: c.split }));
const bench = await loadServerModule("domain/ai/benchmark.js");
const db = new Database(dbPath, { readonly: true });

const jobs = db.prepare("SELECT j.id, j.idempotency_key AS k, j.state, j.created_at, j.started_at, j.finished_at, r.output_json FROM jobs j LEFT JOIN job_results r ON r.job_id = j.id WHERE j.kind = 'benchmark' ORDER BY j.created_at").all();
const out = { rebuiltAt: new Date().toISOString(), source: path.relative(projectRoot, dbPath), manifest: { sha256: createHash("sha256").update(bytes).digest("hex"), status: manifest.status, cases: cases.length }, note: "Peak VRAM per cold trial comes from the run log; the in-memory VRAM sampler of the original process was lost when it was stopped, so warm-pass peaks were not captured.", models: {} };
for (const model of MODELS) {
  const capability = model.startsWith("nimble") ? "triage" : "analysis";
  const mine = jobs.filter((j) => j.k.includes(`:${model}:`) && j.state === "completed");
  const cold = mine.filter((j) => j.k.startsWith("cold:")).map((j) => {
    const r = JSON.parse(j.output_json).results[0];
    return { trial: Number(j.k.split(":").at(-1)), queueWaitMs: Date.parse(j.started_at) - Date.parse(j.created_at), executionMs: r.latencyMs, loadMs: r.loadMs, jobWallMs: Date.parse(j.finished_at) - Date.parse(j.started_at) };
  });
  const passes = mine.filter((j) => j.k.startsWith("warm:")).map((j) => ({ run: Number(j.k.split(":").at(-1)), wallMs: Date.parse(j.finished_at) - Date.parse(j.started_at), results: JSON.parse(j.output_json).results })).sort((a, b) => a.run - b.run);
  if (passes.length === 0) continue;
  const warmRes = passes.flatMap((p, pi) => p.results.filter((_, i) => !(pi === 0 && i === 0)));
  out.models[model] = {
    capability,
    cold,
    warmPasses: passes.map((p) => ({ run: p.run, wallMs: p.wallMs, cases: p.results.length })),
    score: bench.scoreModel(model, capability, cases, passes[0].results),
    scoreEveryPass: passes.map((p) => bench.scoreModel(model, capability, cases, p.results)).map((s) => ({ falsePositive: s.falsePositive.rate, grammarRecall: s.grammarRecall.rate, ambiguousAbstention: s.ambiguousAbstention.rate, jsonBefore: s.jsonValidBeforeRepair.rate })),
    latency: bench.latencySummary(warmRes),
    stability: bench.stability(passes.map((p) => p.results)),
  };
}
const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
const file = path.join(projectRoot, "documentation", "spec", "evidence", "task-009", `benchmark-summary-${stamp}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
console.log("evidence:", file);
