// npm run trial:generate   (REAL Qwen through the single GPU dispatcher; isolated profile var/trial; nothing touches var/db)
// Creates the 24-draft Trial (4 per format), runs it to the end, exports it for review. Drafts only: nothing is approved here.
// Refuses to start when another model is resident in Ollama. Downloads nothing.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadServerModule, projectRoot, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const keep = process.argv.includes("--keep");
const root = path.join(projectRoot, "var", "trial");
if (!keep) rmSync(root, { recursive: true, force: true });
mkdirSync(path.join(root, "db"), { recursive: true });

const { openDatabase } = await loadServerModule("db/open.js");
const { runMigrations } = await loadServerModule("db/migrate.js");
const { GpuScheduler } = await loadServerModule("queue/scheduler.js");
const jobs = await loadServerModule("queue/jobs.js");
const { NvidiaSmiTelemetry } = await loadServerModule("adapters/gpu/nvidiaSmi.js");
const { OllamaClient, OllamaModelControl } = await loadServerModule("adapters/gpu/ollamaClient.js");
const { OllamaChatClient } = await loadServerModule("adapters/ollama/chat.js");
const { GenerationJobRunner } = await loadServerModule("domain/content/batches/generationRunner.js");
const repo = await loadServerModule("domain/content/batches/repository.js");
const exp = await loadServerModule("domain/content/batches/export.js");

const client = new OllamaClient();
const control = new OllamaModelControl(client);
const telemetry = new NvidiaSmiTelemetry();
const resident = await control.listLoaded();
if (resident === null || resident.length > 0) {
  console.error(`Refusing to run: Ollama unreachable or a model is resident (${JSON.stringify(resident)}).`);
  process.exit(2);
}
const version = await client.json("/api/version", { method: "GET", timeoutMs: 5000 });
const tags = await client.json("/api/tags", { method: "GET", timeoutMs: 5000 });

const db = openDatabase(path.join(root, "db", "trial.sqlite"));
await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "generation-trial" });
const deps = { now: () => new Date(), newId: randomUUID };
const runner = new GenerationJobRunner({
  db,
  chat: new OllamaChatClient(client, 300_000),
  installedDigest: async (tag) => tags.models.find((m) => m.name === tag)?.digest ?? null,
  runtimeVersion: async () => version.version,
  deps,
});
const prep = await runner.prepare();
if (!prep.ok) {
  console.error("runner not ready:", prep.reason);
  process.exit(2);
}
const sched = new GpuScheduler({ db, newId: randomUUID, telemetry, control, runners: [runner], instanceId: "generation-trial", config: { idleUnloadMs: 60_000 } });

const { batchId } = repo.createBatch(db, deps, { count: 24, mode: "balanced", trial: true });
console.log(`batch ${batchId} (trial, 24 items); qwen3:8b ${tags.models.find((m) => m.name === "qwen3:8b")?.digest?.slice(0, 12)}; ollama ${version.version}`);
const started = Date.now();
sched.start(500);
try {
  for (;;) {
    const open = db.prepare("SELECT id, state, error_code FROM jobs WHERE batch_id = ? AND state NOT IN ('completed','failed','cancelled')").all(batchId);
    if (open.length === 0) break;
    await new Promise((r) => setTimeout(r, 2000));
    const b = repo.getBatch(db, batchId, false);
    process.stdout.write(`\r${Math.round((Date.now() - started) / 1000)}s queued=${b.counts.queued} drafts=${b.counts.ready_for_review} invalid=${b.counts.invalid} open jobs=${open.length}   `);
  }
} finally {
  await sched.stop();
}
console.log();
const batch = repo.getBatch(db, batchId, true);
const jobRows = db.prepare("SELECT id, state, error_code, retry_count, started_at, finished_at FROM jobs WHERE batch_id = ? ORDER BY created_at").all(batchId);
const results = db.prepare("SELECT j.id, r.metrics_json FROM job_results r JOIN jobs j ON j.id = r.job_id WHERE j.batch_id = ?").all(batchId).map((r) => ({ job: r.id, metrics: JSON.parse(r.metrics_json) }));
const evidence = {
  startedAt: new Date(started).toISOString(),
  wallSeconds: Math.round((Date.now() - started) / 1000),
  environment: { ollama: version.version, node: process.version, model: "qwen3:8b", digest: tags.models.find((m) => m.name === "qwen3:8b")?.digest },
  batchId,
  counts: batch.counts,
  jobs: jobRows,
  perUnit: results.map((r) => ({ job: r.job, calls: r.metrics.calls, repaired: r.metrics.repaired, transportRetries: r.metrics.transportRetries, evalTokens: (r.metrics.stats ?? []).map((s) => s.evalTokens), totalMs: (r.metrics.stats ?? []).map((s) => s.totalMs) })),
  invalid: batch.items.filter((i) => i.status === "invalid").map((i) => ({ ordinal: i.ordinal, type: i.plan.type, skill: i.plan.target_skill, error: i.error })),
  final_ps: await control.listLoaded(),
};
const evDir = path.join(projectRoot, "documentation", "spec", "evidence", "task-010");
mkdirSync(evDir, { recursive: true });
writeFileSync(path.join(evDir, `trial-generation-${new Date(started).toISOString().replace(/[-:]/g, "").slice(0, 15)}Z.json`), JSON.stringify(evidence, null, 2));
const ex = exp.exportBatch(db, batchId);
mkdirSync(path.join(projectRoot, "var", "exports"), { recursive: true });
writeFileSync(path.join(projectRoot, "var", "exports", `batch-${batchId}.json`), JSON.stringify(ex.json, null, 2));
writeFileSync(path.join(projectRoot, "var", "exports", `batch-${batchId}.md`), ex.markdown);
console.log(JSON.stringify({ batchId, counts: batch.counts, wallSeconds: evidence.wallSeconds, invalidCodes: evidence.invalid.map((i) => `${i.ordinal}:${i.type}`) }, null, 1));
db.close();
