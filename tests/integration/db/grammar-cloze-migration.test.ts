import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createBackup } from "../../../apps/server/src/db/backup.js";
import { currentSchemaVersion, runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase } from "../../../apps/server/src/db/open.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

const T = "2026-11-08T00:00:00Z";

it("adds the grammar cloze tables with a verified backup, keeps existing data, rolls back a failed migration and enforces its rules", async () => {
  const scratch = makeScratchRoot();
  const dir = path.join(scratch.root, "migrations");
  const source = path.join(projectRoot, "migrations");
  mkdirSync(dir, { recursive: true });
  for (const n of readdirSync(source).filter((n) => /^\d{3}_.*\.sql$/.test(n) && n < "046_")) copyFileSync(path.join(source, n), path.join(dir, n));
  const db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  const backup = () => createBackup(db, { backupsDir: path.join(scratch.root, "backups"), kind: "premigration", schemaVersion: 45, appVersion: "test" });
  try {
    await runMigrations(db, { migrationsDir: dir, appVersion: "test" });
    const before = { settings: db.prepare("SELECT * FROM settings_revisions").all(), skills: db.prepare("SELECT * FROM skill_revisions").all() };
    const sql = readFileSync(path.join(source, "046_grammar_cloze.sql"), "utf8");
    writeFileSync(path.join(dir, "046_grammar_cloze.sql"), sql + "\nSELECT * FROM missing_table;\n");
    await expect(runMigrations(db, { migrationsDir: dir, appVersion: "test", backup })).rejects.toMatchObject({ code: "MIGRATION_FAILED" });
    expect(currentSchemaVersion(db)).toBe(45);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='grammar_cloze_items'").get()).toBeUndefined();
    writeFileSync(path.join(dir, "046_grammar_cloze.sql"), sql);
    const result = await runMigrations(db, { migrationsDir: dir, appVersion: "test", backup });
    expect(result.applied).toEqual([46]);
    expect(result.premigrationBackup).not.toBeNull();
    expect({ settings: db.prepare("SELECT * FROM settings_revisions").all(), skills: db.prepare("SELECT * FROM skill_revisions").all() }).toEqual(before);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");

    // the rules the tables keep
    db.prepare("INSERT INTO grammar_cloze_imports(id, source_id, source_sha256, clean_version, classifier_version, config_sha256, summary_json, created_at) VALUES ('imp','zanichelli','s','c','k','x','{}',?)").run(T);
    const rev = (id: string, item: string, no: number, skill: string | null, conf: string) => db.prepare("INSERT INTO grammar_cloze_revisions(id, item_id, revision_no, content_hash, gapped_text, solution, distractors_json, filled_text, source_topic, skill_id, skill_confidence, classifier_version, clean_version, flag_reasons_json, import_id, created_at) VALUES (?,?,?,'h','A ___ b','c','[\"d\"]','A c b','articles',?,?,'k','c','[]','imp',?)").run(id, item, no, skill, conf, T);
    expect(() => rev("r0", "zanichelli:1", 1, "articles.definite", "general")).toThrow(); // a skill needs "exact"
    expect(() => rev("r0", "zanichelli:1", 1, null, "exact")).toThrow();
    rev("r1", "zanichelli:1", 1, "articles.definite", "exact");
    rev("r2", "zanichelli:2", 1, null, "general");
    expect(() => rev("r1b", "zanichelli:1", 1, null, "general")).toThrow(); // one revision number per item
    const item = (id: string, idx: number, rid: string) => db.prepare("INSERT INTO grammar_cloze_items(id, source_id, source_index, current_revision_id, status, created_at, updated_at) VALUES (?,'zanichelli',?,?,'validated',?,?)").run(id, idx, rid, T, T);
    item("zanichelli:1", 1, "r1");
    item("zanichelli:2", 2, "r2");
    expect(() => db.prepare("UPDATE grammar_cloze_revisions SET solution='z' WHERE id='r1'").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM grammar_cloze_items WHERE id='zanichelli:1'").run()).toThrow(/never deleted/);
    expect(() => db.prepare("UPDATE grammar_cloze_items SET source_index=9 WHERE id='zanichelli:1'").run()).toThrow(/identity/);
    db.prepare("UPDATE grammar_cloze_items SET status='retired' WHERE id='zanichelli:2'").run();

    const session = (id: string, level: number, status = "active") => db.prepare("INSERT INTO grammar_cloze_sessions(id, level_no, stage, planned_count, status, algorithm_version, seed, settings_revision, tab_id, started_at) VALUES (?,?,1,2,?,'cloze-select-v1',7,1,'t',?)").run(id, level, status, T);
    session("s1", 1);
    expect(() => session("s2", 2)).toThrow(); // one open session
    const planned = (pos: number, itemId: string, revId: string, sid = "s1") => db.prepare("INSERT INTO grammar_cloze_session_items(session_id, position, item_id, revision_id, stage, rule_key, options_json) VALUES (?,?,?,?,1,'articles.definite','[\"c\",\"d\"]')").run(sid, pos, itemId, revId);
    planned(1, "zanichelli:1", "r1");
    expect(() => planned(2, "zanichelli:1", "r1")).toThrow(); // a sentence is planned at most once per stage
    planned(2, "zanichelli:2", "r2");
    db.prepare("UPDATE grammar_cloze_session_items SET first_shown_at=? WHERE session_id='s1' AND position=1").run(T);
    expect(() => db.prepare("UPDATE grammar_cloze_session_items SET first_shown_at='later' WHERE session_id='s1' AND position=1").run()).toThrow(/only the first showing/);
    const attempt = (id: string, pos: number, itemId: string, revId: string) => db.prepare("INSERT INTO grammar_cloze_attempts(id, session_id, position, item_id, revision_id, stage, chosen_text, correct_text, is_correct, rule_key, source_topic, answered_at) VALUES (?,'s1',?,?,?,1,'d','c',0,'articles.definite','articles',?)").run(id, pos, itemId, revId, T);
    attempt("a1", 1, "zanichelli:1", "r1");
    expect(() => attempt("a2", 1, "zanichelli:1", "r1")).toThrow(); // one answer per position
    expect(() => db.prepare("UPDATE grammar_cloze_attempts SET is_correct=1").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM grammar_cloze_attempts").run()).toThrow(/append-only/);
    db.prepare("INSERT INTO grammar_cloze_exclusions(item_id, revision_id, session_id, stage, answered_before, created_at) VALUES ('zanichelli:1','r1','s1',1,1,?)").run(T);
    expect(() => db.prepare("DELETE FROM grammar_cloze_exclusions").run()).toThrow(/append-only/);
    db.prepare("UPDATE grammar_cloze_sessions SET status='completed', completed_at=? WHERE id='s1'").run(T);
    expect(() => db.prepare("UPDATE grammar_cloze_sessions SET tab_id='x' WHERE id='s1'").run()).toThrow(/never changes/);
    session("s2", 2); // a new one may open after completion
    expect(() => db.prepare("INSERT INTO grammar_cloze_activity_intervals(id, session_id, tab_id, start_ms, end_ms, recorded_at) VALUES ('i','s2','t',1,16002,?)").run(T)).toThrow(); // at most 15 s
    db.prepare("INSERT INTO grammar_cloze_ai_analyses(id, revision_id, prompt_version, status, created_at) VALUES ('x1','r1','p','pending',?)").run(T);
    expect(() => db.prepare("INSERT INTO grammar_cloze_ai_analyses(id, revision_id, prompt_version, status, created_at) VALUES ('x2','r1','p','pending',?)").run(T)).toThrow(); // one analysis per revision and prompt
    expect(() => db.prepare("UPDATE grammar_cloze_ai_analyses SET status='done' WHERE id='x1'").run()).toThrow(); // done needs a result
    db.prepare("UPDATE grammar_cloze_ai_analyses SET status='done', result_json='{}' WHERE id='x1'").run();
    expect(() => db.prepare("UPDATE grammar_cloze_ai_analyses SET result_json='[]' WHERE id='x1'").run()).toThrow(/never changes/);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally {
    db.close();
    scratch.cleanup();
  }
});
