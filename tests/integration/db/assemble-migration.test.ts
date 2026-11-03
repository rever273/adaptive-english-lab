import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createBackup } from "../../../apps/server/src/db/backup.js";
import { currentSchemaVersion, runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase } from "../../../apps/server/src/db/open.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

// TASK_026: migration 025 rebuilds the immutable exercise_revisions table only to allow the type 'assemble_sentence'.
it("migrates a populated v24 database with a backup, keeps every row and reference unchanged, and accepts the new type only", async () => {
  const scratch = makeScratchRoot();
  const dir = path.join(scratch.root, "migrations");
  const source = path.join(projectRoot, "migrations");
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(source).filter((n) => /^0(0[1-9]|1[0-9]|2[0-4])_.*\.sql$/.test(n))) copyFileSync(path.join(source, name), path.join(dir, name));
  const db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  try {
    await runMigrations(db, { migrationsDir: dir, appVersion: "test" });
    expect(currentSchemaVersion(db)).toBe(24);
    const tax = (db.prepare("SELECT id FROM taxonomy_versions").get() as { id: string }).id;
    const skill = (db.prepare("SELECT id FROM skill_revisions LIMIT 1").get() as { id: string }).id;
    db.prepare("INSERT INTO exercises(id, created_at) VALUES ('ex','now')").run();
    const types = ["choose_form", "choose_missing_fragment", "detect_error", "guided_short_answer", "russian_to_english_short", "context_reading"];
    types.forEach((t, i) => {
      db.prepare("INSERT INTO exercise_revisions VALUES (?,'ex',?,'exercise-v1',?,?,?,'rubric-v1',?,'recognition','B2','topic','context','cluster','practice','now')").run(`r${i}`, i + 1, t, JSON.stringify({ n: i }), `hash-${i}`, tax);
      db.prepare("INSERT INTO exercise_skills VALUES (?,?,'target')").run(`r${i}`, skill);
    });
    const before = db.prepare("SELECT * FROM exercise_revisions ORDER BY id").all();
    const sqlBefore = (db.prepare("SELECT sql FROM sqlite_master WHERE name='selectable_revisions'").get() as { sql: string }).sql;

    copyFileSync(path.join(source, "025_assemble_sentence.sql"), path.join(dir, "025_assemble_sentence.sql"));
    const result = await runMigrations(db, { migrationsDir: dir, appVersion: "test", backup: () => createBackup(db, { backupsDir: path.join(scratch.root, "backups"), kind: "premigration", schemaVersion: 24, appVersion: "test" }) });
    expect(result.applied).toEqual([25]);
    expect(result.premigrationBackup).not.toBeNull();
    expect(db.prepare("SELECT * FROM exercise_revisions ORDER BY id").all()).toEqual(before); // ids, hashes, content: identical
    expect(db.prepare("SELECT revision_id FROM exercise_skills ORDER BY revision_id").all()).toHaveLength(types.length);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name='selectable_revisions'").get() as { sql: string }).sql).toBe(sqlBefore);
    expect(() => db.prepare("SELECT COUNT(*) FROM selectable_revisions").get()).not.toThrow();

    // immutability survives the rebuild
    expect(() => db.prepare("UPDATE exercise_revisions SET topic='x' WHERE id='r0'").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM exercise_revisions WHERE id='r0'").run()).toThrow(/immutable/);

    // the new type is accepted, an unknown one is not
    db.prepare("INSERT INTO exercise_revisions VALUES ('blk','ex',9,'exercise-v1','assemble_sentence','{}','hash-blk','rubric-v1',?,'recognition','B2','topic','context','cluster','practice','now')").run(tax);
    expect(() => db.prepare("INSERT INTO exercise_revisions VALUES ('bad','ex',10,'exercise-v1','not_a_type','{}','hash-bad','rubric-v1',?,'recognition','B2','topic','context','cluster','practice','now')").run(tax)).toThrow(/CHECK/);

    const backup = openDatabase(path.join(scratch.root, "backups", result.premigrationBackup!.file), { readonly: true });
    try {
      expect(currentSchemaVersion(backup)).toBe(24);
      expect(backup.prepare("SELECT id FROM exercise_revisions ORDER BY id").all()).toHaveLength(types.length);
    } finally {
      backup.close();
    }
  } finally {
    db.close();
    scratch.cleanup();
  }
});
