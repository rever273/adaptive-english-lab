import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createBackup } from "../../../apps/server/src/db/backup.js";
import { currentSchemaVersion, runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase } from "../../../apps/server/src/db/open.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

it("062 adds the frequency and archive columns and widens the sentence source and the event kind, keeping every row", async () => {
  const scratch = makeScratchRoot();
  const dir = path.join(scratch.root, "migrations");
  const source = path.join(projectRoot, "migrations");
  mkdirSync(dir, { recursive: true });
  for (const n of readdirSync(source).filter((n) => /^\d{3}_.*\.sql$/.test(n) && n < "062_")) copyFileSync(path.join(source, n), path.join(dir, n));
  const db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  try {
    await runMigrations(db, { migrationsDir: dir, appVersion: "test" });
    const before = currentSchemaVersion(db);
    const now = "2026-11-24T00:00:00Z";
    db.prepare("INSERT INTO typing_word_bank(lemma, char_count, part_of_speech, translation_ru, definition_ru, transcription, difficulty, status, source_sha256, imported_at, typing_ok, past_forms, participle_forms) VALUES ('table',5,'noun','стол','','t',2,'draft','sha',?,1,'[]','[]')").run(now);
    db.prepare("INSERT INTO vocab_typing_lexicon(lemma, freq_rank, band, updated_at) VALUES ('table', 10, 1, ?)").run(now);
    db.prepare("INSERT INTO vocab_typing_imports(id, corpus, version, inputs_json, counts_json, created_at) VALUES ('i1','tatoeba','v1','{}','{}',?)").run(now);
    db.prepare("INSERT INTO vocab_typing_sentences(id, source, source_en_id, source_ru_id, text_en, text_ru, license_en, license_ru, word_count, difficulty_score, import_id, created_at) VALUES ('s1','tatoeba',1,2,'I see a table.','Я вижу стол.','CC BY 2.0 FR','CC BY 2.0 FR',4,10,'i1',?)").run(now);
    db.prepare("INSERT INTO vocab_typing_sentence_targets(sentence_id, lemma, start, length, surface, rank_for_lemma) VALUES ('s1','table',8,5,'table',1)").run();
    db.prepare("INSERT INTO vocab_typing_sessions(id, stage, status, plan_json, seed, algorithm_version, settings_json, tab_id, started_at) VALUES ('x1','screening','active','{}',1,'v','{}','t',?)").run(now);
    db.prepare("INSERT INTO vocab_typing_events(id, client_event_id, session_id, lemma, stage, kind, typing_json, local_date, created_at) VALUES ('e1','c1','x1','table','screening','screen_not_useful','{}','2026-11-24',?)").run(now);
    const snapshot = () => ({ bank: db.prepare("SELECT lemma, translation_ru FROM typing_word_bank").all(), sentences: db.prepare("SELECT * FROM vocab_typing_sentences").all(), events: db.prepare("SELECT * FROM vocab_typing_events").all(), targets: db.prepare("SELECT * FROM vocab_typing_sentence_targets").all() });
    const was = snapshot();

    copyFileSync(path.join(source, "062_vocab_typing_refine.sql"), path.join(dir, "062_vocab_typing_refine.sql"));
    const result = await runMigrations(db, { migrationsDir: dir, appVersion: "test", backup: () => createBackup(db, { backupsDir: path.join(scratch.root, "backups"), kind: "premigration", schemaVersion: before, appVersion: "test" }) });
    expect(result.applied).toEqual([62]);
    expect(snapshot()).toEqual(was);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.prepare("SELECT archived, archived_by AS by, frequency FROM typing_word_bank").get()).toEqual({ archived: 0, by: null, frequency: null });
    expect(() => db.prepare("UPDATE typing_word_bank SET archived_by = 'robot' WHERE lemma = 'table'").run()).toThrow(/CHECK/);
    db.prepare("UPDATE typing_word_bank SET archived = 1, archived_by = 'learner', archived_at = ?, archive_reason = 'x' WHERE lemma = 'table'").run(now);
    // the new source and the new decision, and every old rule is back
    db.prepare("INSERT INTO vocab_typing_sentences(id, source, source_en_id, source_ru_id, text_en, text_ru, license_en, license_ru, word_count, difficulty_score, import_id, created_at) VALUES ('s2','lexicon',100,100,'He sat at the table.','Он сидел за столом.','own','own',5,10,'i1',?)").run(now);
    expect(() => db.prepare("INSERT INTO vocab_typing_sentences(id, source, source_en_id, source_ru_id, text_en, text_ru, license_en, license_ru, word_count, difficulty_score, import_id, created_at) VALUES ('s3','other',1,1,'x','y','a','b',1,1,'i1',?)").run(now)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE vocab_typing_sentences SET text_en = 'x'").run()).toThrow(/immutable/);
    db.prepare("INSERT INTO vocab_typing_events(id, client_event_id, session_id, lemma, stage, kind, typing_json, local_date, created_at) VALUES ('e2','c2','x1','tablet','screening','screen_archived','{}','2026-11-24',?)").run(now);
    expect(() => db.prepare("INSERT INTO vocab_typing_events(id, client_event_id, session_id, lemma, stage, kind, typing_json, local_date, created_at) VALUES ('e3','c3','x1','tablet2','screening','screen_skip','{}','2026-11-24',?)").run(now)).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO vocab_typing_events(id, client_event_id, session_id, lemma, stage, kind, typing_json, local_date, created_at) VALUES ('e4','c4','x1','table','screening','screen_known','{}','2026-11-24',?)").run(now)).toThrow(/UNIQUE/);
    expect(() => db.prepare("UPDATE vocab_typing_events SET kind = 'screen_known'").run()).toThrow(/append-only/);
    // the XP guard still finds events in the rebuilt table
    db.prepare("INSERT INTO vocab_typing_events(id, client_event_id, session_id, lemma, stage, kind, typing_json, local_date, created_at) VALUES ('e5','c5','x1','chair','screening','screen_known','{}','2026-11-24',?)").run(now);
    db.prepare("INSERT INTO mode_xp_events(id, track, source, source_id, amount, rule_version, created_at) VALUES ('x','vocabulary','vocabTyping','e5',1,'mode-xp-v1',?)").run(now);
    expect(() => db.prepare("INSERT INTO mode_xp_events(id, track, source, source_id, amount, rule_version, created_at) VALUES ('y','vocabulary','vocabTyping','nope',1,'mode-xp-v1',?)").run(now)).toThrow(/requires/);
  } finally {
    db.close();
    scratch.cleanup();
  }
});
