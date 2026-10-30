// npm run backup: manual verified backup through the SQLite online backup API (safe while the server runs).
import { existsSync } from "node:fs";
import { loadServerModule, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const { loadConfig } = await loadServerModule("config.js");
const { openDatabase } = await loadServerModule("db/open.js");
const { createBackup, verifyBackup } = await loadServerModule("db/backup.js");
const { currentSchemaVersion } = await loadServerModule("db/migrate.js");

const config = loadConfig();
if (!existsSync(config.dbPath)) {
  console.error("No database yet; start the application once (npm start) before backing up.");
  process.exit(1);
}
const db = openDatabase(config.dbPath);
try {
  const manifest = await createBackup(db, {
    backupsDir: config.backupsDir,
    kind: "manual",
    schemaVersion: currentSchemaVersion(db),
    appVersion: config.appVersion,
  });
  const check = verifyBackup(config.backupsDir, manifest);
  console.log(JSON.stringify({ ...manifest, verify: check }, null, 2));
  if (!check.checksumOk || check.integrity !== "ok" || check.foreignKeyViolations !== 0) process.exit(1);
} finally {
  db.close();
}
