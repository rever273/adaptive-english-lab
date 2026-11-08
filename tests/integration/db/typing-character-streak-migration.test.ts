import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createBackup, verifyBackup } from "../../../apps/server/src/db/backup.js";
import { currentSchemaVersion, runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase } from "../../../apps/server/src/db/open.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

it("backs up version 40, rolls back a failed migration and preserves existing finished sessions", async () => {
  const scratch = makeScratchRoot(), dir = path.join(scratch.root, "migrations"), source = path.join(projectRoot, "migrations");
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(source).filter((n) => /^\d{3}_.*\.sql$/.test(n) && n < "041_")) copyFileSync(path.join(source, name), path.join(dir, name));
  const db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  const backupDir = path.join(scratch.root, "backups");
  const backup = () => createBackup(db, { backupsDir: backupDir, kind: "premigration", schemaVersion: 40, appVersion: "test" });
  try {
    await runMigrations(db, { migrationsDir: dir, appVersion: "test" });
    db.prepare("INSERT INTO typing_sessions(id, mode, status, level_number, settings_revision, settings_json, plan_json, started_at, ended_at, best_combo) VALUES ('old', 'words', 'completed', 1, 1, '{}', '{\"words\":[]}', 'before', 'after', 5)").run();
    const before = db.prepare("SELECT id, status, best_combo, chars_typed FROM typing_sessions WHERE id='old'").get();
    const sql = readFileSync(path.join(source, "041_typing_character_streak.sql"), "utf8");
    writeFileSync(path.join(dir, "041_typing_character_streak.sql"), sql + "\nSELECT * FROM missing_table;\n");
    await expect(runMigrations(db, { migrationsDir: dir, appVersion: "test", backup })).rejects.toMatchObject({ code: "MIGRATION_FAILED" });
    expect(currentSchemaVersion(db)).toBe(40);
    expect((db.pragma("table_info(typing_sessions)") as Array<{name:string}>).some((column) => column.name === "best_char_streak")).toBe(false);
    writeFileSync(path.join(dir, "041_typing_character_streak.sql"), sql);
    const result = await runMigrations(db, { migrationsDir: dir, appVersion: "test", backup });
    expect(result.applied).toEqual([41]);
    expect(result.premigrationBackup).not.toBeNull();
    expect(verifyBackup(backupDir, result.premigrationBackup!)).toMatchObject({ checksumOk: true, integrity: "ok", foreignKeyViolations: 0 });
    expect(db.prepare("SELECT id, status, best_combo, chars_typed FROM typing_sessions WHERE id='old'").get()).toEqual(before);
    expect(db.prepare("SELECT best_char_streak, current_char_streak FROM typing_sessions WHERE id='old'").get()).toEqual({ best_char_streak: null, current_char_streak: null });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    const old = openDatabase(path.join(backupDir, result.premigrationBackup!.file), { readonly: true });
    try { expect(currentSchemaVersion(old)).toBe(40); expect(old.prepare("SELECT id, status, best_combo, chars_typed FROM typing_sessions WHERE id='old'").get()).toEqual(before); } finally { old.close(); }
  } finally { db.close(); scratch.cleanup(); }
});
