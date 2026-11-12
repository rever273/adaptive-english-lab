import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createBackup, verifyBackup } from "../../../apps/server/src/db/backup.js";
import { currentSchemaVersion, runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase } from "../../../apps/server/src/db/open.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

it("migration 050 keeps every conversation as a topic chat, backs up and rolls back on failure", async () => {
  const scratch = makeScratchRoot();
  const dir = path.join(scratch.root, "migrations"), source = path.join(projectRoot, "migrations");
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(source).filter((n) => /^\d{3}_.*\.sql$/.test(n) && n < "050_")) copyFileSync(path.join(source, name), path.join(dir, name));
  const db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  const backupDir = path.join(scratch.root, "backups");
  try {
    await runMigrations(db, { migrationsDir: dir, appVersion: "test" });
    db.prepare("INSERT INTO conversation_sessions(id, topic, status, started_at, updated_at, active_ms, answer_count) VALUES ('a', 'Coffee', 'paused', 'then', 'then', 5000, 3)").run();
    db.prepare("INSERT INTO conversation_messages(id, session_id, role, text, created_at) VALUES ('m', 'a', 'assistant', 'Hello', 'then')").run();
    const before = db.prepare("SELECT * FROM conversation_sessions WHERE id='a'").get() as Record<string, unknown>;
    const sql = readFileSync(path.join(source, "050_conversation_lessons.sql"), "utf8"), dest = path.join(dir, "050_conversation_lessons.sql");
    const backup = () => createBackup(db, { backupsDir: backupDir, kind: "premigration", schemaVersion: currentSchemaVersion(db), appVersion: "test" });
    writeFileSync(dest, sql + "\nSELECT * FROM missing_table;\n");
    await expect(runMigrations(db, { migrationsDir: dir, appVersion: "test", backup })).rejects.toMatchObject({ code: "MIGRATION_FAILED" });
    expect(currentSchemaVersion(db)).toBe(49);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='conversation_lesson_targets'").get()).toBeUndefined();
    writeFileSync(dest, sql);
    const result = await runMigrations(db, { migrationsDir: dir, appVersion: "test", backup });
    expect(result.applied).toEqual([50]);
    expect(verifyBackup(backupDir, result.premigrationBackup!)).toMatchObject({ checksumOk: true, integrity: "ok", foreignKeyViolations: 0 });
    expect(db.prepare("SELECT * FROM conversation_sessions WHERE id='a'").get()).toEqual({ ...before, mode: "topic" });
    expect(db.prepare("SELECT count(*) AS n FROM conversation_messages").get()).toEqual({ n: 1 });
    expect(() => db.prepare("UPDATE conversation_sessions SET mode='other' WHERE id='a'").run()).toThrow(/CHECK/);
    db.prepare("INSERT INTO conversation_lesson_targets(session_id, ordinal, kind, target_key, label, brief_json) VALUES ('a', 0, 'word', 'reckon', 'reckon', '{}')").run();
    expect(() => db.prepare("INSERT INTO conversation_lesson_targets(session_id, ordinal, kind, target_key, label, brief_json) VALUES ('missing', 0, 'word', 'x', 'x', '{}')").run()).toThrow(/FOREIGN KEY/);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    const old = openDatabase(path.join(backupDir, result.premigrationBackup!.file), { readonly: true });
    try { expect(currentSchemaVersion(old)).toBe(49); expect(old.prepare("SELECT * FROM conversation_sessions WHERE id='a'").get()).toEqual(before); } finally { old.close(); }
  } finally { db.close(); scratch.cleanup(); }
});
