// npm run typing:seed [-- --csv <file>] [-- --db <sqlite file>]
// Imports the learner's old word list into the replaceable `typing_word_bank` (D72). Columns are found by header name. The bank is replaced in
// one transaction, so a reseed is idempotent and history is never touched. The CSV stays local and is never published.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadServerModule, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);

const { loadConfig } = await loadServerModule("config.js");
const { openDatabase } = await loadServerModule("db/open.js");
const { importWordBank } = await loadServerModule("domain/typing/wordBank.js");

const config = loadConfig();
const csvFile = opt("--csv") ?? config.lexiconCsv;
if (!csvFile) {
  console.error("No CSV source: pass --csv <file> or set lexiconCsv in englishlab.local.json");
  process.exit(2);
}
const dbFile = path.resolve(opt("--db") ?? config.dbPath);
if (!existsSync(dbFile)) {
  console.error(`database not found: ${dbFile} (start the app once to apply migrations)`);
  process.exit(2);
}

const csvText = readFileSync(csvFile, "utf8");
const sourceSha = createHash("sha256").update(csvText).digest("hex");
const db = openDatabase(dbFile);
try {
  const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'typing_word_bank'").get();
  if (!hasTable) {
    console.error("typing_word_bank table is missing: start the app once to apply migrations");
    process.exit(2);
  }
  const result = importWordBank(db, csvText, sourceSha, { now: () => new Date() });
  console.log(JSON.stringify({ ...result, source: csvFile, sourceSha256: sourceSha }, null, 2));
} finally {
  db.close();
}
