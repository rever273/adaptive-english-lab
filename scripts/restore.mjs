// npm run restore -- --list
// npm run restore -- --backup <id> [--dry-run]            shows what a restore would roll back; changes nothing
// npm run restore -- --backup <id> --confirm <id>         restores (the application must be STOPPED)
// Maintenance workflow (spec/11): verify the backup, save a verified safety backup of the current data and a delta export of the newer rows, replace,
// re-check, and put the previous data back if anything fails. It never runs while the application holds its lock.
import { existsSync } from "node:fs";
import { loadServerModule, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const { loadConfig } = await loadServerModule("config.js");
const { listBackups } = await loadServerModule("db/backup.js");
const { restoreBackup, RestoreError } = await loadServerModule("db/restore.js");
const { readLock, classifyLock } = await loadServerModule("lock.js");
const config = loadConfig();

if (args.includes("--list")) {
  const all = listBackups(config.backupsDir);
  if (all.length === 0) console.log("No backups yet. Run: npm run backup");
  for (const b of all) console.log(`${b.file}  ${b.kind}  schema ${b.schemaVersion}  ${b.createdAt}`);
  process.exit(0);
}
const backupId = opt("--backup");
if (!backupId) {
  console.error("usage: npm run restore -- --list | --backup <id> [--dry-run] | --backup <id> --confirm <id>");
  process.exit(2);
}
const lock = readLock(config.lockPath);
if (lock && classifyLock(lock) !== "stale" && !args.includes("--dry-run")) {
  console.error(`English Lab is running (pid ${lock.pid}). Stop it first with: npm run stop`);
  process.exit(3);
}
try {
  const report = await restoreBackup({ dbPath: config.dbPath, backupsDir: config.backupsDir, migrationsDir: config.migrationsDir, appVersion: config.appVersion, backupId, confirmId: opt("--confirm"), dryRun: args.includes("--dry-run") });
  console.log(JSON.stringify(report, null, 2));
  if (!existsSync(config.dbPath)) process.exit(1);
} catch (e) {
  if (e instanceof RestoreError) {
    console.error(`${e.code}: ${e.message}`);
    if (Object.keys(e.details).length > 0) console.error(JSON.stringify(e.details));
    process.exit(e.code === "RESTORE_NOT_CONFIRMED" ? 2 : 1);
  }
  throw e;
}
