import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createBackup, verifyBackup } from "../../../apps/server/src/db/backup.js";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

let scratch: ReturnType<typeof makeScratchRoot> | null = null;
let db: Db | null = null;
afterEach(() => { db?.close(); db = null; scratch?.cleanup(); scratch = null; });

it("keeps the matching-game history through the repeat-count migration, still append-only, and allows 1-10 repeats", async () => {
  scratch = makeScratchRoot();
  const dir = path.join(scratch.root, "migrations");
  mkdirSync(dir, { recursive: true });
  const real = path.join(projectRoot, "migrations");
  for (const file of readdirSync(real).filter((f) => /^\d{3}_.*\.sql$/.test(f) && f < "054_")) copyFileSync(path.join(real, file), path.join(dir, file));
  db = openDatabase(path.join(scratch.root, "test.sqlite"));
  await runMigrations(db, { migrationsDir: dir, appVersion: "test" });
  const t = "2026-01-01T00:00:00.000Z";
  const settings = (db.prepare("SELECT id FROM settings_revisions LIMIT 1").get() as { id: string }).id;
  const taxonomy = (db.prepare("SELECT id FROM taxonomy_versions LIMIT 1").get() as { id: string }).id;
  const plan = "plan1";
  db.prepare("INSERT INTO learning_plans(id,revision,priorities_json,rationale,reviewer,created_at,taxonomy_id) VALUES (?,?,?,?,?,?,?)").run(plan, 1, "[]", "test", "test", t, taxonomy);
  db.prepare("INSERT INTO sessions(id,purpose,settings_revision_id,plan_id,selection_version,random_seed,status,created_at,timezone) VALUES ('s1','practice',?,?,'v','seed','completed',?,'Australia/Brisbane')").run(settings, plan, t);
  const put = db.prepare("INSERT INTO vocabulary_match_results(id,session_id,lemma,mode,needed,matched,wrong,rule_version,created_at) VALUES (?,?,?,?,?,?,?,?,?)");
  put.run("r1", "s1", "home", "rush", 5, 5, 0, "vocabulary-match-v1", t);
  put.run("r2", "s1", "dog", "once", 1, 0, 2, "vocabulary-match-v1", t);
  expect(() => put.run("bad", "s1", "cat", "rush", 4, 4, 0, "v", t)).toThrow(/CHECK/); // 4 repeats were not allowed before
  const before = db.prepare("SELECT rowid, * FROM vocabulary_match_results ORDER BY rowid").all();
  copyFileSync(path.join(real, "054_vocabulary_match_rounds.sql"), path.join(dir, "054_vocabulary_match_rounds.sql"));
  const backupDir = path.join(scratch.root, "backups");
  const result = await runMigrations(db, { migrationsDir: dir, appVersion: "test", backup: () => createBackup(db!, { backupsDir: backupDir, kind: "premigration", schemaVersion: 53, appVersion: "test" }) });
  expect(result.applied).toEqual([54]);
  expect(db.prepare("SELECT rowid, * FROM vocabulary_match_results ORDER BY rowid").all()).toEqual(before);
  expect(db.pragma("foreign_key_check")).toEqual([]);
  expect(() => db!.prepare("UPDATE vocabulary_match_results SET matched = 0").run()).toThrow(/append-only/);
  expect(() => db!.prepare("DELETE FROM vocabulary_match_results").run()).toThrow(/append-only/);
  put.run("ok4", "s1", "cat", "rush", 4, 4, 1, "v", t);
  put.run("ok10", "s1", "bird", "rush", 10, 10, 0, "v", t);
  expect(() => put.run("bad11", "s1", "fish", "rush", 11, 11, 0, "v", t)).toThrow(/CHECK/);
  expect(() => put.run("bad0", "s1", "cow", "rush", 0, 0, 0, "v", t)).toThrow(/CHECK/);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'vocabulary_match_results_lemma'").get()).toBeTruthy();
  expect(verifyBackup(backupDir, result.premigrationBackup!)).toMatchObject({ checksumOk: true, integrity: "ok", foreignKeyViolations: 0 });
  const old = openDatabase(path.join(backupDir, result.premigrationBackup!.file));
  try { expect(old.prepare("SELECT rowid, * FROM vocabulary_match_results ORDER BY rowid").all()).toEqual(before); } finally { old.close(); }
});
