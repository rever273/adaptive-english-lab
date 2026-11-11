// npm run cloze:import -- --source zanichelli [--in var/grammar-cloze/zanichelli/cleaned.json] [--db <file>] [--apply]
// Imports the output of `npm run cloze:prepare` into SQLite (TASK_032). WITHOUT --apply it only prints what would change (nothing is written).
// With --apply: a verified backup first, then ONE transaction. Idempotent: running it again adds nothing; answers and exclusions are never touched.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadServerModule, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const source = opt("--source", "zanichelli");
const input = path.resolve(opt("--in", path.join("var", "grammar-cloze", source, "cleaned.json")));
const apply = args.includes("--apply");

const { loadConfig } = await loadServerModule("config.js");
const { openDatabase } = await loadServerModule("db/open.js");
const { importCleaned } = await loadServerModule("domain/grammarCloze/importer.js");
const { createBackup, verifyBackup } = await loadServerModule("db/backup.js");
const { currentSchemaVersion } = await loadServerModule("db/migrate.js");

const config = loadConfig();
const dbFile = path.resolve(opt("--db", config.dbPath));
if (!existsSync(dbFile)) { console.error(`database not found: ${dbFile} (start the app once to apply migrations)`); process.exit(2); }
if (!existsSync(input)) { console.error(`prepared file not found: ${input} (run npm run cloze:prepare first)`); process.exit(2); }
const file = JSON.parse(readFileSync(input, "utf8"));
if (file.source !== source) { console.error(`the prepared file is for source "${file.source}", not "${source}"`); process.exit(2); }
const db = openDatabase(dbFile);
try {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='grammar_cloze_items'").get()) { console.error("grammar_cloze tables are missing: start the app once to apply migration 046"); process.exit(2); }
  if (apply) {
    const manifest = await createBackup(db, { backupsDir: config.backupsDir, kind: "manual", schemaVersion: currentSchemaVersion(db), appVersion: config.appVersion });
    const check = verifyBackup(config.backupsDir, manifest);
    if (!check.checksumOk || check.integrity !== "ok" || check.foreignKeyViolations !== 0) { console.error("the backup did not verify; nothing was imported"); process.exit(1); }
    console.log(`backup ${manifest.file ?? ""} verified`);
  }
  const summary = importCleaned(db, file, { apply });
  console.log(JSON.stringify(summary, null, 2));
  if (!apply) console.log("dry run: nothing was written. Add --apply to import.");
} finally {
  db.close();
}
