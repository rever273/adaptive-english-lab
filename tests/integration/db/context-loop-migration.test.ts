import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createBackup } from "../../../apps/server/src/db/backup.js";
import { currentSchemaVersion, runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase } from "../../../apps/server/src/db/open.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

it("057 adds the Context Loop tables and rebuilds mode_xp_events without losing a row or a rule", async () => {
  const scratch = makeScratchRoot();
  const dir = path.join(scratch.root, "migrations");
  const source = path.join(projectRoot, "migrations");
  mkdirSync(dir, { recursive: true });
  for (const n of readdirSync(source).filter((n) => /^\d{3}_.*\.sql$/.test(n) && n < "057_")) copyFileSync(path.join(source, n), path.join(dir, n));
  const db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  try {
    await runMigrations(db, { migrationsDir: dir, appVersion: "test" });
    expect(currentSchemaVersion(db)).toBe(56);
    // existing XP history: written past the guard (the rows it protects are not needed for this check), then the guard is put back
    db.exec("DROP TRIGGER mode_xp_guard");
    const put = db.prepare("INSERT INTO mode_xp_events(id, track, source, source_id, amount, rule_version, created_at) VALUES (?,?,?,?,?,?,?)");
    put.run("x1", "grammar", "grammarCloze", "a1", 10, "mode-xp-v1", "2026-11-01T00:00:00Z");
    put.run("x2", "vocabulary", "wordLesson", "r1", 35, "mode-xp-v1", "2026-11-02T00:00:00Z");
    put.run("x3", "conversation", "conversation", "m1", 10, "mode-xp-v1", "2026-11-03T00:00:00Z");
    db.exec("CREATE TRIGGER mode_xp_guard BEFORE INSERT ON mode_xp_events WHEN 0 BEGIN SELECT 1; END");
    db.prepare("INSERT INTO vocabulary_entries(id, lemma, pos, language, surface_forms_json, created_at) VALUES ('e1','reluctant','adjective','en','[]','2026-11-01T00:00:00Z')").run();
    const before = db.prepare("SELECT * FROM mode_xp_events ORDER BY id").all();

    copyFileSync(path.join(source, "057_context_loop.sql"), path.join(dir, "057_context_loop.sql"));
    const result = await runMigrations(db, { migrationsDir: dir, appVersion: "test", backup: () => createBackup(db, { backupsDir: path.join(scratch.root, "backups"), kind: "premigration", schemaVersion: 56, appVersion: "test" }) });
    expect(result.applied).toEqual([57]);
    expect(result.premigrationBackup).not.toBeNull();
    expect(db.prepare("SELECT * FROM mode_xp_events ORDER BY id").all()).toEqual(before);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");

    // the XP ledger keeps its rules, and the new source needs a recalled answer behind it
    expect(() => db.prepare("UPDATE mode_xp_events SET amount = 1").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM mode_xp_events").run()).toThrow(/append-only/);
    expect(() => put.run("x4", "grammar", "grammarCloze", "missing", 10, "v", "x")).toThrow(/requires/);
    expect(() => put.run("x5", "vocabulary", "contextLoop", "missing", 2, "v", "x")).toThrow(/requires/);

    const now = "2026-11-22T00:00:00Z";
    db.prepare("INSERT INTO context_loop_sentences(id, entry_id, lemma, sense_json, text, target_surface, target_start, target_length, context_label, difficulty, fingerprint, source, created_at) VALUES ('s1','e1','reluctant','{}','She was reluctant to leave.','reluctant',8,9,'home','easy','k1','model',?)").run(now);
    expect(() => db.prepare("UPDATE context_loop_sentences SET text = 'x'").run()).toThrow(/immutable/);
    expect(() => db.prepare("INSERT INTO context_loop_sentence_status(id, sentence_id, status, actor, created_at) VALUES ('st1','s1','approved','model',?)").run(now)).toThrow(); // only an agent review approves
    db.prepare("INSERT INTO context_loop_sentence_status(id, sentence_id, status, actor, created_at) VALUES ('st1','s1','validated','model',?)").run(now);
    db.prepare("INSERT INTO context_loop_sessions(id, tab_id, status, plan_json, seed, queue_version, started_at) VALUES ('c1','t','active','{}',1,'q',?)").run(now);
    expect(() => db.prepare("INSERT INTO context_loop_sessions(id, tab_id, status, plan_json, seed, queue_version, started_at) VALUES ('c2','t','active','{}',1,'q',?)").run(now)).toThrow(); // one active session
    const attempt = db.prepare("INSERT INTO context_loop_attempts(id, session_id, card_index, entry_id, sentence_id, kind, encounter, new_context, same_in_session, outcome, aids_json, rule_version, local_date, created_at) VALUES (?, 'c1', ?, 'e1', 's1', ?, 1, 1, 0, ?, '{}', 'v', '2026-11-22', ?)");
    expect(() => attempt.run("a0", 0, "card", "correct", now)).toThrow(); // a card is self-assessed
    attempt.run("a1", 0, "card", "recalled", now);
    expect(() => attempt.run("a2", 0, "card", "not_recalled", now)).toThrow(); // one answer per place
    expect(() => db.prepare("UPDATE context_loop_attempts SET outcome = 'not_recalled'").run()).toThrow(/append-only/);
    put.run("x6", "vocabulary", "contextLoop", "a1", 2, "mode-xp-v1", now);
    expect(() => put.run("x7", "vocabulary", "contextLoop", "a1", 2, "mode-xp-v1", now)).toThrow(); // one row per source
    db.prepare("UPDATE context_loop_sessions SET status='completed', completed_at=? WHERE id='c1'").run(now);
    expect(() => db.prepare("UPDATE context_loop_sessions SET tab_id='u' WHERE id='c1'").run()).toThrow(/never changes/);

    const previous = openDatabase(path.join(scratch.root, "backups", result.premigrationBackup!.file), { readonly: true });
    try {
      expect(currentSchemaVersion(previous)).toBe(56);
    } finally {
      previous.close();
    }
  } finally {
    db.close();
    scratch.cleanup();
  }
});

it("059 lets a batch ask for up to 15 sentences per word, keeping every batch and the sentences that point at them", async () => {
  const scratch = makeScratchRoot();
  const dir = path.join(scratch.root, "migrations");
  const source = path.join(projectRoot, "migrations");
  mkdirSync(dir, { recursive: true });
  for (const n of readdirSync(source).filter((n) => /^\d{3}_.*\.sql$/.test(n) && n < "059_")) copyFileSync(path.join(source, n), path.join(dir, n));
  const db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  try {
    await runMigrations(db, { migrationsDir: dir, appVersion: "test" });
    const now = "2026-11-23T00:00:00Z";
    db.prepare("INSERT INTO vocabulary_entries(id, lemma, pos, language, surface_forms_json, created_at) VALUES ('e1','reluctant','adjective','en','[]',?)").run(now);
    db.prepare("INSERT INTO context_loop_batches(id, author, requested_words, per_word, status, words_json, prompt_version, created_at, finished_at) VALUES ('b1','model',1,4,'done','[]','context-loop-v1',?,?)").run(now, now);
    expect(() => db.prepare("INSERT INTO context_loop_batches(id, author, requested_words, per_word, status, words_json, prompt_version, created_at) VALUES ('b2','model',1,15,'generating','[]','v',?)").run(now)).toThrow();
    db.prepare("INSERT INTO context_loop_sentences(id, entry_id, lemma, sense_json, text, target_surface, target_start, target_length, context_label, difficulty, fingerprint, source, batch_id, created_at) VALUES ('s1','e1','reluctant','{}','She was reluctant to leave.','reluctant',8,9,'home','easy','k1','model','b1',?)").run(now);
    const before = db.prepare("SELECT * FROM context_loop_batches").all();
    copyFileSync(path.join(source, "059_context_loop_per_word.sql"), path.join(dir, "059_context_loop_per_word.sql"));
    const result = await runMigrations(db, { migrationsDir: dir, appVersion: "test", backup: () => createBackup(db, { backupsDir: path.join(scratch.root, "backups"), kind: "premigration", schemaVersion: 58, appVersion: "test" }) });
    expect(result.applied).toEqual([59]);
    expect(db.prepare("SELECT * FROM context_loop_batches").all()).toEqual(before);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.prepare("INSERT INTO context_loop_batches(id, author, requested_words, per_word, status, words_json, prompt_version, created_at) VALUES ('b2','model',1,15,'generating','[]','v',?)").run(now);
    expect(() => db.prepare("INSERT INTO context_loop_batches(id, author, requested_words, per_word, status, words_json, prompt_version, created_at) VALUES ('b3','model',1,16,'generating','[]','v',?)").run(now)).toThrow();
    expect(() => db.prepare("UPDATE context_loop_batches SET per_word = 5 WHERE id = 'b2'").run()).toThrow(/identity/);
    expect(() => db.prepare("DELETE FROM context_loop_batches WHERE id = 'b1'").run()).toThrow(/never deleted/);
    // the sentences still point at their batch
    expect(() => db.prepare("INSERT INTO context_loop_sentences(id, entry_id, lemma, sense_json, text, target_surface, target_start, target_length, context_label, difficulty, fingerprint, source, batch_id, created_at) VALUES ('s2','e1','reluctant','{}','x','reluctant',0,9,'home','easy','k2','model','missing',?)").run(now)).toThrow(/FOREIGN KEY/);
  } finally {
    db.close();
    scratch.cleanup();
  }
});

it("060 adds an optional Russian translation to Context Loop sentences; existing rows keep NULL and stay immutable", async () => {
  const scratch = makeScratchRoot();
  const dir = path.join(scratch.root, "migrations");
  const source = path.join(projectRoot, "migrations");
  mkdirSync(dir, { recursive: true });
  for (const n of readdirSync(source).filter((n) => /^\d{3}_.*\.sql$/.test(n) && n < "060_")) copyFileSync(path.join(source, n), path.join(dir, n));
  const db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  try {
    await runMigrations(db, { migrationsDir: dir, appVersion: "test" });
    const now = "2026-11-24T00:00:00Z";
    db.prepare("INSERT INTO vocabulary_entries(id, lemma, pos, language, surface_forms_json, created_at) VALUES ('e1','reluctant','adjective','en','[]',?)").run(now);
    const put = "INSERT INTO context_loop_sentences(id, entry_id, lemma, sense_json, text, target_surface, target_start, target_length, context_label, difficulty, fingerprint, source, created_at";
    db.prepare(`${put}) VALUES ('s1','e1','reluctant','{}','She was reluctant to leave.','reluctant',8,9,'home','easy','k1','model',?)`).run(now);
    const before = db.prepare("SELECT * FROM context_loop_sentences").all();
    copyFileSync(path.join(source, "060_context_loop_translation.sql"), path.join(dir, "060_context_loop_translation.sql"));
    const result = await runMigrations(db, { migrationsDir: dir, appVersion: "test", backup: () => createBackup(db, { backupsDir: path.join(scratch.root, "backups"), kind: "premigration", schemaVersion: 59, appVersion: "test" }) });
    expect(result.applied).toEqual([60]);
    expect(result.premigrationBackup).not.toBeNull();
    expect(db.prepare("SELECT * FROM context_loop_sentences").all()).toEqual((before as Array<Record<string, unknown>>).map((r) => ({ ...r, translation_ru: null })));
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.prepare(`${put}, translation_ru) VALUES ('s2','e1','reluctant','{}','He was reluctant to talk.','reluctant',7,9,'home','easy','k2','agent',?,'Он не хотел говорить.')`).run(now);
    expect(() => db.prepare(`${put}, translation_ru) VALUES ('s3','e1','reluctant','{}','x','reluctant',0,9,'home','easy','k3','agent',?,'')`).run(now)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE context_loop_sentences SET translation_ru = 'Она не хотела уходить.' WHERE id = 's1'").run()).toThrow(/immutable/);
  } finally {
    db.close();
    scratch.cleanup();
  }
});
