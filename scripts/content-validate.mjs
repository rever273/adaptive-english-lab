// npm run content:validate -- --batch <UUID> [--db <sqlite file>]
// Re-runs schema + semantic validation on every stored revision of a batch and cross-checks the batch bookkeeping.
// Read-only. Exit code 0 = everything consistent, 1 = a problem was found, 2 = bad usage.
import path from "node:path";
import { loadServerModule, projectRoot, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const batchId = opt("--batch", "");
const { loadConfig } = await loadServerModule("config.js");
const config = loadConfig();
const dbPath = path.resolve(opt("--db", config.dbPath));
if (!/^[0-9a-f-]{36}$/i.test(batchId)) {
  console.error("usage: npm run content:validate -- --batch <UUID> [--db <file>]");
  process.exit(2);
}
const { openDatabase } = await loadServerModule("db/open.js");
const { validateExercise } = await loadServerModule("domain/content/validator.js");
const { getBatch } = await loadServerModule("domain/content/batches/repository.js");
const db = openDatabase(dbPath, { readonly: true });
const problems = [];
try {
  const batch = getBatch(db, batchId, true);
  const skills = new Set(db.prepare("SELECT sr.skill_id AS id FROM skill_revisions sr JOIN taxonomy_versions t ON t.id = sr.taxonomy_id WHERE sr.active = 1").all().map((r) => r.id));
  const total = Object.values(batch.counts).reduce((a, b) => a + b, 0);
  if (total !== batch.requestedCount) problems.push(`item counts sum to ${total}, batch requested ${batch.requestedCount}`);
  for (const item of batch.items) {
    if (!item.revisionId) continue;
    const row = db.prepare("SELECT content_json AS c, content_hash AS h FROM exercise_revisions WHERE id = ?").get(item.revisionId);
    const v = validateExercise(JSON.parse(row.c), { taxonomySkillIds: skills });
    if (!v.ok) problems.push(`#${item.ordinal} ${item.revisionId}: ${v.errors.map((e) => `${e.code} ${e.path}`).join("; ")}`);
    else if (v.contentHash !== row.h) problems.push(`#${item.ordinal} ${item.revisionId}: stored hash differs from the recomputed content hash`);
    if (item.status === "released" || item.status === "approved") {
      const ok = db.prepare("SELECT 1 FROM content_reviews WHERE revision_id = ? AND verdict = 'approved' AND content_hash = ?").get(item.revisionId, row.h);
      if (!ok) problems.push(`#${item.ordinal} ${item.revisionId}: approved without an approved review of the current hash`);
    }
  }
  console.log(`batch ${batchId}: ${batch.purpose}, requested ${batch.requestedCount}`);
  console.log(`counts: ${Object.entries(batch.counts).map(([k, v]) => `${k}=${v}`).join(" ")}`);
} catch (e) {
  problems.push(e.message);
} finally {
  db.close();
}
if (problems.length > 0) {
  console.error(`INVALID (${problems.length}):\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("OK: every stored revision validates and the batch bookkeeping is consistent");
