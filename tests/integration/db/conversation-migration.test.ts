import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createBackup, verifyBackup } from "../../../apps/server/src/db/backup.js";
import { currentSchemaVersion, runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase } from "../../../apps/server/src/db/open.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

it("preserves existing data, backs up and rolls back a failed conversation migration", async () => {
  const scratch = makeScratchRoot();
  const dir = path.join(scratch.root, "migrations"), source = path.join(projectRoot, "migrations");
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(source).filter((n) => /^\d{3}_.*\.sql$/.test(n) && n < "044_")) copyFileSync(path.join(source, name), path.join(dir, name));
  const db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  const backupDir = path.join(scratch.root, "backups");
  try {
    await runMigrations(db, { migrationsDir: dir, appVersion: "test" });
    db.prepare("INSERT INTO typing_sessions(id, mode, status, level_number, settings_revision, settings_json, plan_json, started_at, ended_at) VALUES ('old', 'words', 'completed', 1, 1, '{}', '{\"words\":[]}', 'before', 'after')").run();
    const before = db.prepare("SELECT * FROM typing_sessions WHERE id='old'").get();
    const sql = readFileSync(path.join(source, "044_conversation.sql"), "utf8");
    const dest = path.join(dir, "044_conversation.sql");
    const backup = () => createBackup(db, { backupsDir: backupDir, kind: "premigration", schemaVersion: currentSchemaVersion(db), appVersion: "test" });
    writeFileSync(dest, sql + "\nSELECT * FROM missing_table;\n");
    await expect(runMigrations(db, { migrationsDir: dir, appVersion: "test", backup })).rejects.toMatchObject({ code: "MIGRATION_FAILED" });
    expect(currentSchemaVersion(db)).toBe(43);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='conversation_sessions'").get()).toBeUndefined();
    writeFileSync(dest, sql);
    const result = await runMigrations(db, { migrationsDir: dir, appVersion: "test", backup });
    expect(result.applied).toEqual([44]);
    expect(verifyBackup(backupDir, result.premigrationBackup!)).toMatchObject({ checksumOk: true, integrity: "ok", foreignKeyViolations: 0 });
    expect(db.prepare("SELECT * FROM typing_sessions WHERE id='old'").get()).toEqual(before);
    db.prepare("INSERT INTO conversation_sessions(id, topic, status, started_at, updated_at, answer_count) VALUES (?, 'Coffee', 'paused', 'now', 'now', 1)").run("a");
    db.prepare("INSERT INTO conversation_sessions(id, topic, status, started_at, updated_at) VALUES (?, 'Travel', 'paused', 'now', 'now')").run("b");
    db.prepare("INSERT INTO conversation_messages(id, session_id, role, text, created_at) VALUES ('answer', 'a', 'user', 'Hello', 'now')").run();
    expect(() => db.prepare("INSERT INTO conversation_messages(id, session_id, role, text, created_at, reply_to) VALUES ('wrong', 'b', 'assistant', 'Hello', 'now', 'answer')").run()).toThrow();
    db.prepare("INSERT INTO conversation_analyses(message_id, status, created_at) VALUES ('answer', 'pending', 'now')").run();
    db.prepare("DELETE FROM conversation_messages WHERE session_id = 'a'").run();
    expect(db.prepare("SELECT count(*) AS n FROM conversation_analyses").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT answer_count FROM conversation_sessions WHERE id='a'").get()).toEqual({ answer_count: 1 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    const old = openDatabase(path.join(backupDir, result.premigrationBackup!.file), { readonly: true });
    try { expect(currentSchemaVersion(old)).toBe(43); expect(old.prepare("SELECT * FROM typing_sessions WHERE id='old'").get()).toEqual(before); } finally { old.close(); }
    db.prepare("UPDATE conversation_sessions SET active_ms=12345 WHERE id='a'").run();
    const beforeConversation = db.prepare("SELECT * FROM conversation_sessions WHERE id='a'").get();
    const activitySql = readFileSync(path.join(source, "045_conversation_activity.sql"), "utf8"), activityDest = path.join(dir, "045_conversation_activity.sql");
    writeFileSync(activityDest, activitySql + "\nSELECT * FROM missing_table;\n");
    await expect(runMigrations(db, { migrationsDir: dir, appVersion: "test", backup })).rejects.toMatchObject({code:"MIGRATION_FAILED"});
    expect(currentSchemaVersion(db)).toBe(44); expect(db.prepare("SELECT name FROM sqlite_master WHERE name='conversation_activity_baseline'").get()).toBeUndefined();
    writeFileSync(activityDest, activitySql);
    const activityResult = await runMigrations(db, { migrationsDir: dir, appVersion:"test", backup });
    expect(activityResult.applied).toEqual([45]); expect(verifyBackup(backupDir,activityResult.premigrationBackup!)).toMatchObject({checksumOk:true,integrity:"ok",foreignKeyViolations:0});
    expect(db.prepare("SELECT * FROM conversation_sessions WHERE id='a'").get()).toEqual(beforeConversation);
    expect(db.prepare("SELECT active_ms FROM conversation_activity_baseline WHERE session_id='a'").get()).toEqual({active_ms:12345});
    expect(db.pragma("foreign_key_check")).toEqual([]);
    const rollback = openDatabase(path.join(backupDir, activityResult.premigrationBackup!.file), {readonly:true});
    try { expect(currentSchemaVersion(rollback)).toBe(44); expect(rollback.prepare("SELECT * FROM conversation_sessions WHERE id='a'").get()).toEqual(beforeConversation); } finally {rollback.close();}
  } finally { db.close(); scratch.cleanup(); }
});
