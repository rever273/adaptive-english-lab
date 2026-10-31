// npm run lab:verdicts -- apply <manifest.json> [--db <sqlite file>]
// Applies an attempt-verdict-review-v1 manifest (D65): for each answer that waits for a decision it APPENDS a new confirmed assessment revision
// (the earlier AI verdict stays in the history). All or nothing; a stale sequence refuses the whole manifest; applying it twice is a no-op.
// Safe while the app runs (one short write transaction). Export the queue first: npm run lab:export -- verdicts
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadServerModule, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const [cmd, file] = args;
if (cmd !== "apply" || !file || file.startsWith("--")) {
  console.error("usage: npm run lab:verdicts -- apply <manifest.json> [--db <sqlite file>]");
  process.exit(2);
}
const { loadConfig } = await loadServerModule("config.js");
const { openDatabase } = await loadServerModule("db/open.js");
const { applyAttemptVerdicts } = await loadServerModule("domain/reports/attemptVerdictReview.js");
const config = loadConfig();
const dbFile = path.resolve(opt("--db") ?? config.dbPath);
if (!existsSync(dbFile)) {
  console.error(`database not found: ${dbFile}`);
  process.exit(2);
}
const db = openDatabase(dbFile);
try {
  const result = applyAttemptVerdicts(db, { now: () => new Date(), newId: randomUUID }, JSON.parse(readFileSync(path.resolve(file), "utf8")));
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(`not applied: ${e.message}`);
  if (e.details) console.error(JSON.stringify(e.details, null, 2));
  process.exitCode = 1;
} finally {
  db.close();
}
