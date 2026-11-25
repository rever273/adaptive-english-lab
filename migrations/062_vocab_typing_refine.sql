-- Migration 062 (TASK_038 section 11, D177-D179, D184): Vocabulary Typing refinement. Runs inside a runner-managed transaction with foreign keys off (see migrate.ts).
--  * typing_word_bank gets `frequency` (the third CSV column) and the archive fields: an archived word (by the learner with Backspace, or by the cleanup)
--    is never used for practice anywhere in the project; it is NOT deleted (D184);
--  * vocab_typing_events accepts the new decision `screen_archived` (`screen_not_useful` of migration 061 stays valid as its synonym);
--  * vocab_typing_sentences accepts source 'lexicon' (the learner's own CSV examples, D179).
-- SQLite cannot change a CHECK, so the two tables are rebuilt with every row copied unchanged and their triggers and indexes restored.
-- Rollback note: restore the pre-migration backup the runner makes. Do not edit after it has been applied.
ALTER TABLE typing_word_bank ADD COLUMN frequency REAL;
ALTER TABLE typing_word_bank ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1));
ALTER TABLE typing_word_bank ADD COLUMN archived_by TEXT CHECK (archived_by IS NULL OR archived_by IN ('model','learner'));
ALTER TABLE typing_word_bank ADD COLUMN archived_at TEXT;
ALTER TABLE typing_word_bank ADD COLUMN archive_reason TEXT;

CREATE TABLE vocab_typing_sentences_new (
  id               TEXT PRIMARY KEY NOT NULL,
  source           TEXT NOT NULL CHECK (source IN ('tatoeba','lexicon')),
  source_en_id     INTEGER NOT NULL,
  source_ru_id     INTEGER NOT NULL,
  text_en          TEXT NOT NULL,
  text_ru          TEXT NOT NULL,
  author_en        TEXT,
  author_ru        TEXT,
  license_en       TEXT NOT NULL,
  license_ru       TEXT NOT NULL,
  word_count       INTEGER NOT NULL CHECK (word_count >= 1),
  difficulty_score REAL NOT NULL,
  import_id        TEXT NOT NULL REFERENCES vocab_typing_imports(id) ON DELETE RESTRICT,
  created_at       TEXT NOT NULL,
  UNIQUE (source, source_en_id)
);
INSERT INTO vocab_typing_sentences_new(id, source, source_en_id, source_ru_id, text_en, text_ru, author_en, author_ru, license_en, license_ru, word_count, difficulty_score, import_id, created_at)
  SELECT id, source, source_en_id, source_ru_id, text_en, text_ru, author_en, author_ru, license_en, license_ru, word_count, difficulty_score, import_id, created_at FROM vocab_typing_sentences;
DROP TABLE vocab_typing_sentences;
ALTER TABLE vocab_typing_sentences_new RENAME TO vocab_typing_sentences;
CREATE TRIGGER vocab_typing_sentences_no_update BEFORE UPDATE ON vocab_typing_sentences BEGIN SELECT RAISE(ABORT, 'vocab_typing_sentences is immutable'); END;
CREATE TRIGGER vocab_typing_sentences_no_delete BEFORE DELETE ON vocab_typing_sentences BEGIN SELECT RAISE(ABORT, 'vocab_typing_sentences is immutable'); END;

CREATE TABLE vocab_typing_events_new (
  id              TEXT PRIMARY KEY NOT NULL,
  client_event_id TEXT NOT NULL UNIQUE,
  session_id      TEXT NOT NULL REFERENCES vocab_typing_sessions(id) ON DELETE RESTRICT,
  lemma           TEXT NOT NULL,
  stage           TEXT NOT NULL CHECK (stage IN ('screening','learning')),
  kind            TEXT NOT NULL CHECK (kind IN ('screen_known','screen_unknown','screen_not_useful','screen_archived','learn_exposure','learn_learned')),
  sentence_id     TEXT REFERENCES vocab_typing_sentences(id) ON DELETE RESTRICT,
  is_probe        INTEGER NOT NULL DEFAULT 0 CHECK (is_probe IN (0,1)),
  card_index      INTEGER CHECK (card_index IS NULL OR card_index >= 0),
  typing_json     TEXT NOT NULL CHECK (json_valid(typing_json)),
  local_date      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  CHECK ((stage = 'screening') = (kind LIKE 'screen\_%' ESCAPE '\')),
  CHECK ((stage = 'learning') = (sentence_id IS NOT NULL)),
  CHECK ((stage = 'learning') = (card_index IS NOT NULL))
);
INSERT INTO vocab_typing_events_new(id, client_event_id, session_id, lemma, stage, kind, sentence_id, is_probe, card_index, typing_json, local_date, created_at)
  SELECT id, client_event_id, session_id, lemma, stage, kind, sentence_id, is_probe, card_index, typing_json, local_date, created_at FROM vocab_typing_events;
DROP TABLE vocab_typing_events;
ALTER TABLE vocab_typing_events_new RENAME TO vocab_typing_events;
CREATE UNIQUE INDEX vocab_typing_events_one_screen ON vocab_typing_events(session_id, lemma) WHERE stage = 'screening';
CREATE UNIQUE INDEX vocab_typing_events_one_card ON vocab_typing_events(session_id, card_index) WHERE card_index IS NOT NULL;
CREATE INDEX vocab_typing_events_lemma ON vocab_typing_events(lemma, created_at);
CREATE INDEX vocab_typing_events_day ON vocab_typing_events(local_date);
CREATE TRIGGER vocab_typing_events_no_update BEFORE UPDATE ON vocab_typing_events BEGIN SELECT RAISE(ABORT, 'vocab_typing_events is append-only'); END;
CREATE TRIGGER vocab_typing_events_no_delete BEFORE DELETE ON vocab_typing_events BEGIN SELECT RAISE(ABORT, 'vocab_typing_events is append-only'); END;
