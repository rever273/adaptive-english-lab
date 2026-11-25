import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createBackup } from "../../../apps/server/src/db/backup.js";
import { currentSchemaVersion, runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase } from "../../../apps/server/src/db/open.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

it("061 adds the Vocabulary Typing tables, rebuilds mode_xp_events without losing a row and leaves the word bank untouched", async () => {
  const scratch = makeScratchRoot();
  const dir = path.join(scratch.root, "migrations");
  const source = path.join(projectRoot, "migrations");
  mkdirSync(dir, { recursive: true });
  for (const n of readdirSync(source).filter((n) => /^\d{3}_.*\.sql$/.test(n) && n < "061_")) copyFileSync(path.join(source, n), path.join(dir, n));
  const db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  try {
    await runMigrations(db, { migrationsDir: dir, appVersion: "test" });
    const before = currentSchemaVersion(db);
    db.exec("DROP TRIGGER mode_xp_guard");
    const put = db.prepare("INSERT INTO mode_xp_events(id, track, source, source_id, amount, rule_version, created_at) VALUES (?,?,?,?,?,?,?)");
    put.run("x1", "grammar", "grammarCloze", "a1", 10, "mode-xp-v1", "2026-11-01T00:00:00Z");
    put.run("x2", "vocabulary", "contextLoop", "a2", 2, "mode-xp-v1", "2026-11-02T00:00:00Z");
    db.exec("CREATE TRIGGER mode_xp_guard BEFORE INSERT ON mode_xp_events WHEN 0 BEGIN SELECT 1; END");
    const bank = db.prepare("INSERT INTO typing_word_bank(lemma, char_count, part_of_speech, translation_ru, definition_ru, transcription, difficulty, status, source_sha256, imported_at, typing_ok, past_forms, participle_forms) VALUES (?,?,?,?,?,?,?,'draft','sha','2026-11-01T00:00:00Z',1,?,?)");
    bank.run("run", 3, "verb", "бежать", "", "rʌn", 2, '["ran"]', '["run"]');
    bank.run("table", 5, "noun", "стол", "", "teɪbl", 2, "[]", "[]");
    const xpBefore = db.prepare("SELECT * FROM mode_xp_events ORDER BY id").all();
    const bankBefore = db.prepare("SELECT * FROM typing_word_bank ORDER BY lemma").all();

    copyFileSync(path.join(source, "061_vocab_typing.sql"), path.join(dir, "061_vocab_typing.sql"));
    const result = await runMigrations(db, { migrationsDir: dir, appVersion: "test", backup: () => createBackup(db, { backupsDir: path.join(scratch.root, "backups"), kind: "premigration", schemaVersion: before, appVersion: "test" }) });
    expect(result.applied).toEqual([61]);
    expect(result.premigrationBackup).not.toBeNull();
    expect(db.prepare("SELECT * FROM mode_xp_events ORDER BY id").all()).toEqual(xpBefore);
    expect(db.prepare("SELECT * FROM typing_word_bank ORDER BY lemma").all()).toEqual(bankBefore);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    // the XP ledger keeps its rules; the new source needs a screening decision or a passed check behind it
    expect(() => db.prepare("UPDATE mode_xp_events SET amount = 1").run()).toThrow(/append-only/);
    expect(() => put.run("x3", "grammar", "grammarCloze", "missing", 10, "v", "x")).toThrow(/requires/);
    expect(() => put.run("x4", "vocabulary", "vocabTyping", "missing", 1, "v", "x")).toThrow(/requires/);

    const now = "2026-11-24T00:00:00Z";
    db.prepare("INSERT INTO vocab_typing_lexicon(lemma, freq_rank, band, updated_at) VALUES ('run', 120, 1, ?)").run(now);
    expect(() => db.prepare("INSERT INTO vocab_typing_lexicon(lemma, freq_rank, band, updated_at) VALUES ('table', 120, 1, ?)").run(now)).toThrow(/UNIQUE/);
    expect(() => db.prepare("INSERT INTO vocab_typing_lexicon(lemma, freq_rank, band, eligibility, updated_at) VALUES ('table', 130, 1, 'maybe', ?)").run(now)).toThrow(/CHECK/);

    db.prepare("INSERT INTO vocab_typing_sessions(id, stage, status, plan_json, seed, algorithm_version, settings_json, tab_id, started_at) VALUES ('s1','screening','active','{}',1,'v','{}','t',?)").run(now);
    expect(() => db.prepare("INSERT INTO vocab_typing_sessions(id, stage, status, plan_json, seed, algorithm_version, settings_json, tab_id, started_at) VALUES ('s2','screening','active','{}',1,'v','{}','t',?)").run(now)).toThrow(/UNIQUE/);
    const ev = "INSERT INTO vocab_typing_events(id, client_event_id, session_id, lemma, stage, kind, sentence_id, card_index, typing_json, local_date, created_at) VALUES (?,?,'s1',?,?,?,?,?,'{}','2026-11-24',?)";
    db.prepare(ev).run("e1", "c1", "run", "screening", "screen_known", null, null, now);
    expect(() => db.prepare(ev).run("e2", "c2", "run", "screening", "screen_unknown", null, null, now)).toThrow(/UNIQUE/); // one screening decision per word and session
    expect(() => db.prepare(ev).run("e3", "c1", "table", "screening", "screen_known", null, null, now)).toThrow(/UNIQUE/); // idempotent by client id
    expect(() => db.prepare(ev).run("e4", "c4", "table", "screening", "learn_learned", null, null, now)).toThrow(/CHECK/); // kind and stage agree
    expect(() => db.prepare("UPDATE vocab_typing_events SET kind = 'screen_unknown'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM vocab_typing_events").run()).toThrow(/append-only/);
    // a screening decision earns XP, a "not useful" one does not
    put.run("x5", "vocabulary", "vocabTyping", "e1", 1, "mode-xp-v1", now);
    db.prepare(ev).run("e5", "c5", "table", "screening", "screen_not_useful", null, null, now);
    expect(() => put.run("x6", "vocabulary", "vocabTyping", "e5", 1, "mode-xp-v1", now)).toThrow(/requires/);

    // sentences and their targets are immutable, statuses are append-only and never `approved`
    db.prepare("INSERT INTO vocab_typing_imports(id, corpus, version, inputs_json, counts_json, created_at) VALUES ('i1','tatoeba','v1','{}','{}',?)").run(now);
    db.prepare("INSERT INTO vocab_typing_sentences(id, source, source_en_id, source_ru_id, text_en, text_ru, license_en, license_ru, word_count, difficulty_score, import_id, created_at) VALUES ('t1','tatoeba',1,2,'I run every day.','Я бегаю каждый день.','CC BY 2.0 FR','CC BY 2.0 FR',4,100,'i1',?)").run(now);
    db.prepare("INSERT INTO vocab_typing_sentence_targets(sentence_id, lemma, start, length, surface, rank_for_lemma) VALUES ('t1','run',2,3,'run',1)").run();
    expect(() => db.prepare("UPDATE vocab_typing_sentences SET text_en = 'x'").run()).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE vocab_typing_sentence_targets SET start = 0").run()).toThrow(/immutable/);
    expect(() => db.prepare("INSERT INTO vocab_typing_sentence_status(id, sentence_id, status, actor, created_at) VALUES ('st1','t1','approved','code',?)").run(now)).toThrow(/CHECK/);
    db.prepare("INSERT INTO vocab_typing_sentence_status(id, sentence_id, status, actor, created_at) VALUES ('st1','t1','validated','code',?)").run(now);
    expect(() => db.prepare("DELETE FROM vocab_typing_sentence_status").run()).toThrow(/append-only/);

    // cloze checks: a skipped one has no rating, every other one has; one answer per place
    const rv = "INSERT INTO vocab_typing_reviews(id, client_event_id, session_id, lemma, card_index, sentence_id, expected, outcome, rating, algorithm_version, local_date, created_at) VALUES (?,?,'s1','run',?,'t1','run',?,?,'v','2026-11-24',?)";
    expect(() => db.prepare(rv).run("r0", "rc0", 0, "skipped", "good", now)).toThrow(/CHECK/);
    expect(() => db.prepare(rv).run("r0", "rc0", 0, "incorrect", null, now)).toThrow(/CHECK/);
    db.prepare(rv).run("r1", "rc1", 0, "correct", "good", now);
    expect(() => db.prepare(rv).run("r2", "rc2", 0, "typo", "good", now)).toThrow(/UNIQUE/);
    put.run("x7", "vocabulary", "vocabTyping", "r1", 5, "mode-xp-v1", now);
    expect(() => db.prepare("UPDATE vocab_typing_reviews SET outcome = 'incorrect'").run()).toThrow(/append-only/);

    // a finished session never changes
    db.prepare("UPDATE vocab_typing_sessions SET status = 'completed', ended_at = ? WHERE id = 's1'").run(now);
    expect(() => db.prepare("UPDATE vocab_typing_sessions SET tab_id = 'u' WHERE id = 's1'").run()).toThrow(/never changes/);
    expect(() => db.prepare("DELETE FROM vocab_typing_sessions").run()).toThrow(/never deleted/);

    const previous = openDatabase(path.join(scratch.root, "backups", result.premigrationBackup!.file), { readonly: true });
    try {
      expect(currentSchemaVersion(previous)).toBe(before);
    } finally {
      previous.close();
    }
  } finally {
    db.close();
    scratch.cleanup();
  }
});
