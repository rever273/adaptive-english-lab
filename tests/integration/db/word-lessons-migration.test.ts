import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createBackup } from "../../../apps/server/src/db/backup.js";
import { currentSchemaVersion, runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase } from "../../../apps/server/src/db/open.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

it("adds the word lesson tables with a verified backup, keeps the existing data and rolls back a failed migration", async () => {
  const scratch = makeScratchRoot();
  const dir = path.join(scratch.root, "migrations");
  const source = path.join(projectRoot, "migrations");
  mkdirSync(dir, { recursive: true });
  for (const n of readdirSync(source).filter((n) => /^\d{3}_.*\.sql$/.test(n) && n < "040_")) copyFileSync(path.join(source, n), path.join(dir, n));
  const db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  const backup = () => createBackup(db, { backupsDir: path.join(scratch.root, "backups"), kind: "premigration", schemaVersion: 39, appVersion: "test" });
  try {
    await runMigrations(db, { migrationsDir: dir, appVersion: "test" });
    db.prepare("INSERT INTO vocabulary_entries(id, lemma, pos, language, surface_forms_json, created_at) VALUES ('e1','overlook','verb','en','[]','2026-11-01T00:00:00Z')").run();
    const before = { settings: db.prepare("SELECT * FROM settings_revisions").all(), words: db.prepare("SELECT * FROM vocabulary_entries").all() };
    const sql = readFileSync(path.join(source, "040_word_lessons.sql"), "utf8");
    writeFileSync(path.join(dir, "040_word_lessons.sql"), sql + "\nSELECT * FROM missing_table;\n");
    await expect(runMigrations(db, { migrationsDir: dir, appVersion: "test", backup })).rejects.toMatchObject({ code: "MIGRATION_FAILED" });
    expect(currentSchemaVersion(db)).toBe(39);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='word_lessons'").get()).toBeUndefined();
    writeFileSync(path.join(dir, "040_word_lessons.sql"), sql);
    const result = await runMigrations(db, { migrationsDir: dir, appVersion: "test", backup });
    expect(result.applied).toEqual([40]);
    expect(result.premigrationBackup).not.toBeNull();
    expect({ settings: db.prepare("SELECT * FROM settings_revisions").all(), words: db.prepare("SELECT * FROM vocabulary_entries").all() }).toEqual(before);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    const previous = openDatabase(path.join(scratch.root, "backups", result.premigrationBackup!.file), { readonly: true });
    try {
      expect(currentSchemaVersion(previous)).toBe(39);
      expect(previous.prepare("SELECT name FROM sqlite_master WHERE name='word_lessons'").get()).toBeUndefined();
    } finally {
      previous.close();
    }

    // the rules the tables keep
    const lesson = (status: string, extra = "") => db.prepare(`INSERT INTO word_lessons(id, entry_id, lemma, sense_json, plan_json, status, settings_revision, created_at${extra ? ", content_json, content_status, schema_version, ready_at" : ""}) VALUES ('l1','e1','overlook','{}','{}','${status}',1,'2026-11-01T00:00:00Z'${extra})`).run();
    expect(() => lesson("ready")).toThrow(); // ready needs validated content
    expect(() => lesson("ready", ",'{}','approved','word-lesson-v1','2026-11-01T00:00:00Z'")).toThrow(); // never approved
    lesson("generating");
    expect(() => db.prepare("INSERT INTO word_lessons(id, entry_id, lemma, sense_json, plan_json, status, settings_revision, created_at) VALUES ('l2','e1','overlook','{}','{}','generating',1,'2026-11-01T00:00:00Z')").run()).toThrow(); // one open lesson per word
    db.prepare("UPDATE word_lessons SET status='ready', content_json='{}', content_status='validated', schema_version='word-lesson-v1', ready_at='2026-11-01T00:00:01Z' WHERE id='l1'").run();
    expect(() => db.prepare("UPDATE word_lessons SET status='failed' WHERE id='l1'").run()).toThrow();
    db.prepare("INSERT INTO word_lesson_runs(id, lesson_id, tab_id, seed, status, started_at) VALUES ('r1','l1','t',1,'active','2026-11-01T00:00:02Z')").run();
    expect(() => db.prepare("INSERT INTO word_lesson_runs(id, lesson_id, tab_id, seed, status, started_at) VALUES ('r2','l1','t',1,'active','2026-11-01T00:00:03Z')").run()).toThrow(); // one open run per lesson
    expect(() => db.prepare("INSERT INTO word_lesson_attempts(id, run_id, item_key, attempt_no, answer_text, input, created_at) VALUES ('a1','r1','s2',1,'x','voice','2026-11-01T00:00:04Z')").run()).toThrow(); // a voice answer keeps what was heard
    db.prepare("INSERT INTO word_lesson_attempts(id, run_id, item_key, attempt_no, answer_text, input, created_at) VALUES ('a1','r1','s2',1,'x','text','2026-11-01T00:00:04Z')").run();
    expect(() => db.prepare("UPDATE word_lesson_attempts SET answer_text='y'").run()).toThrow(/append-only/);
    db.prepare("UPDATE word_lesson_runs SET status='completed', completed_at='2026-11-01T00:01:00Z', score=70, score_version='v' WHERE id='r1'").run();
    expect(() => db.prepare("UPDATE word_lesson_runs SET score=99 WHERE id='r1'").run()).toThrow(/never changes/);
    expect(() => db.prepare("INSERT INTO word_lesson_activity_intervals(id, run_id, tab_id, start_ms, end_ms, recorded_at) VALUES ('i','r1','t',1,16002,'x')").run()).toThrow(); // at most 15 s
  } finally {
    db.close();
    scratch.cleanup();
  }
});
