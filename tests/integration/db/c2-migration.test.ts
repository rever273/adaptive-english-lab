import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createBackup } from "../../../apps/server/src/db/backup.js";
import { currentSchemaVersion, runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase } from "../../../apps/server/src/db/open.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

it("migrates a populated v19 database with a backup, preserves references and settings history, and accepts C2", async () => {
  const scratch = makeScratchRoot();
  const dir = path.join(scratch.root, "migrations");
  const source = path.join(projectRoot, "migrations");
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(source).filter((n) => /^0(0[1-9]|1[0-9])_.*\.sql$/.test(n))) copyFileSync(path.join(source, name), path.join(dir, name));
  const db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  try {
    await runMigrations(db, { migrationsDir: dir, appVersion: "test" });
    expect(currentSchemaVersion(db)).toBe(19);
    const tax = (db.prepare("SELECT id FROM taxonomy_versions").get() as { id: string }).id;
    const skill = (db.prepare("SELECT id FROM skill_revisions LIMIT 1").get() as { id: string }).id;
    db.prepare("INSERT INTO exercises(id, created_at) VALUES ('ex','now')").run();
    db.prepare("INSERT INTO exercise_revisions VALUES ('old','ex',1,'exercise-v1','choose_form','{}','hash-old','rubric-v1',?,'recognition','B2','topic','context','cluster','practice','now')").run(tax);
    db.prepare("INSERT INTO exercise_skills VALUES ('old',?,'target')").run(skill);
    const oldSettings = db.prepare("SELECT * FROM settings_revisions").all();
    copyFileSync(path.join(source, "020_exercise_c2.sql"), path.join(dir, "020_exercise_c2.sql"));
    const result = await runMigrations(db, { migrationsDir: dir, appVersion: "test", backup: () => createBackup(db, { backupsDir: path.join(scratch.root, "backups"), kind: "premigration", schemaVersion: 19, appVersion: "test" }) });
    expect(result.applied).toEqual([20]);
    expect(result.premigrationBackup).not.toBeNull();
    expect(db.prepare("SELECT * FROM settings_revisions WHERE revision=1").all()).toEqual(oldSettings);
    expect(JSON.parse((db.prepare("SELECT values_json AS v FROM settings_revisions WHERE revision=2").get() as { v: string }).v)).toMatchObject({ difficultyMin: "B1", difficultyMax: "C1" });
    expect(db.prepare("SELECT revision_id FROM exercise_skills").all()).toEqual([{ revision_id: "old" }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(() => db.prepare("UPDATE exercise_revisions SET difficulty='C1' WHERE id='old'").run()).toThrow(/immutable/);
    db.prepare("INSERT INTO exercise_revisions VALUES ('new','ex',2,'exercise-v1','choose_form','{}','hash-new','rubric-v1',?,'recognition','C2','topic','context','cluster','practice','now')").run(tax);
    expect((db.prepare("SELECT difficulty FROM exercise_revisions WHERE id='new'").get() as { difficulty: string }).difficulty).toBe("C2");
    const backup = openDatabase(path.join(scratch.root, "backups", result.premigrationBackup!.file), { readonly: true });
    try { expect(currentSchemaVersion(backup)).toBe(19); expect(backup.prepare("SELECT id FROM exercise_revisions").all()).toEqual([{ id: "old" }]); } finally { backup.close(); }
  } finally { db.close(); scratch.cleanup(); }
});

it("rolls back a failed table rebuild and restores foreign-key enforcement", async () => {
  const scratch = makeScratchRoot();
  const dir = path.join(scratch.root, "migrations");
  const source = path.join(projectRoot, "migrations");
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(source).filter((n) => /^0(0[1-9]|1[0-9])_.*\.sql$/.test(n))) copyFileSync(path.join(source, name), path.join(dir, name));
  const db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  try {
    await runMigrations(db, { migrationsDir: dir, appVersion: "test" });
    const broken = readFileSync(path.join(source, "020_exercise_c2.sql"), "utf8") + "\nSELECT * FROM table_that_does_not_exist;\n";
    writeFileSync(path.join(dir, "020_exercise_c2.sql"), broken);
    await expect(runMigrations(db, { migrationsDir: dir, appVersion: "test", backup: () => createBackup(db, { backupsDir: path.join(scratch.root, "backups"), kind: "premigration", schemaVersion: 19, appVersion: "test" }) })).rejects.toMatchObject({ code: "MIGRATION_FAILED" });
    expect(currentSchemaVersion(db)).toBe(19);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name='exercise_revisions'").get() as { sql: string }).sql).not.toContain("'C2'");
  } finally { db.close(); scratch.cleanup(); }
});

it("does not replace a range already selected in a v19 profile", async () => {
  const scratch = makeScratchRoot();
  const dir = path.join(scratch.root, "migrations");
  const source = path.join(projectRoot, "migrations");
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(source).filter((n) => /^0(0[1-9]|1[0-9])_.*\.sql$/.test(n))) copyFileSync(path.join(source, name), path.join(dir, name));
  const db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  try {
    await runMigrations(db, { migrationsDir: dir, appVersion: "test" });
    const initial = (db.prepare("SELECT values_json AS v FROM settings_revisions WHERE revision=1").get() as { v: string }).v;
    db.prepare("INSERT INTO settings_revisions VALUES ('chosen',2,?, 'now')").run(JSON.stringify({ ...JSON.parse(initial), difficultyMin: "B2", difficultyMax: "C1" }));
    const before = db.prepare("SELECT * FROM settings_revisions ORDER BY revision").all();
    copyFileSync(path.join(source, "020_exercise_c2.sql"), path.join(dir, "020_exercise_c2.sql"));
    await runMigrations(db, { migrationsDir: dir, appVersion: "test", backup: () => createBackup(db, { backupsDir: path.join(scratch.root, "backups"), kind: "premigration", schemaVersion: 19, appVersion: "test" }) });
    expect(db.prepare("SELECT * FROM settings_revisions ORDER BY revision").all()).toEqual(before);
  } finally { db.close(); scratch.cleanup(); }
});
