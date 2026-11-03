-- Migration 026 (TASK_027, D70-D80): typing practice. New tables only.
-- typing_word_bank is a replaceable reference imported from the learner's old CSV (draft, unverified); history never references it.
-- Progress is derived from typing_sessions; there is no mutable progress table. A session row changes only while it is active.
-- Runs inside a runner-managed transaction. Do not edit after it has been applied.

CREATE TABLE typing_word_bank (
  lemma          TEXT PRIMARY KEY NOT NULL CHECK (lemma NOT GLOB '*[^a-z]*' AND length(lemma) BETWEEN 2 AND 32),
  char_count     INTEGER NOT NULL CHECK (char_count = length(lemma)),
  part_of_speech TEXT NOT NULL,
  translation_ru TEXT NOT NULL CHECK (length(translation_ru) > 0),
  definition_ru  TEXT NOT NULL,
  transcription  TEXT NOT NULL,
  difficulty     INTEGER NOT NULL CHECK (difficulty BETWEEN 2 AND 5),
  status         TEXT NOT NULL CHECK (status = 'draft'),
  source_sha256  TEXT NOT NULL,
  imported_at    TEXT NOT NULL
);
CREATE INDEX typing_word_bank_pick ON typing_word_bank(difficulty, char_count);

CREATE TABLE typing_books (
  id             TEXT PRIMARY KEY NOT NULL,
  title          TEXT NOT NULL,
  author         TEXT NOT NULL,
  source         TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  text_length    INTEGER NOT NULL CHECK (text_length > 0),
  chapters_json  TEXT NOT NULL CHECK (json_valid(chapters_json)),
  created_at     TEXT NOT NULL
);
CREATE TRIGGER typing_books_no_update BEFORE UPDATE ON typing_books BEGIN SELECT RAISE(ABORT, 'typing_books is immutable: offsets depend on the file'); END;
CREATE TRIGGER typing_books_no_delete BEFORE DELETE ON typing_books BEGIN SELECT RAISE(ABORT, 'typing_books is immutable: offsets depend on the file'); END;

CREATE TABLE typing_sessions (
  id                TEXT PRIMARY KEY NOT NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('words','books')),
  status            TEXT NOT NULL CHECK (status IN ('active','completed','failed','interrupted')),
  level_number      INTEGER NOT NULL CHECK (level_number >= 1),
  settings_revision INTEGER NOT NULL,
  settings_json     TEXT NOT NULL CHECK (json_valid(settings_json)),
  plan_json         TEXT CHECK (plan_json IS NULL OR json_valid(plan_json)),
  started_at        TEXT NOT NULL,
  ended_at          TEXT,
  -- raw counters from the client, cumulative across sittings
  active_ms         INTEGER NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  chars_typed       INTEGER NOT NULL DEFAULT 0 CHECK (chars_typed >= 0),
  errors            INTEGER NOT NULL DEFAULT 0 CHECK (errors >= 0),
  -- derived by the server at the end, recomputable from the above
  chars_correct     INTEGER,
  wpm               REAL,
  cpm               REAL,
  accuracy          REAL,
  score             INTEGER,
  metrics_version   TEXT,
  -- books only
  book_id           TEXT REFERENCES typing_books(id) ON DELETE RESTRICT,
  start_offset      INTEGER,
  end_offset        INTEGER,
  current_offset    INTEGER,
  CHECK (mode = 'words' OR status <> 'failed'),
  CHECK ((mode = 'words') = (plan_json IS NOT NULL)),
  CHECK ((mode = 'books') = (book_id IS NOT NULL)),
  CHECK (mode = 'words' OR (start_offset IS NOT NULL AND end_offset > start_offset AND current_offset BETWEEN start_offset AND end_offset)),
  CHECK ((status = 'active') = (ended_at IS NULL))
);
CREATE INDEX typing_sessions_mode_ended ON typing_sessions(mode, ended_at);
CREATE UNIQUE INDEX typing_one_active ON typing_sessions(mode) WHERE status = 'active';
CREATE UNIQUE INDEX typing_words_level_once ON typing_sessions(level_number) WHERE mode = 'words' AND status = 'completed';
CREATE UNIQUE INDEX typing_books_level_once ON typing_sessions(book_id, level_number) WHERE mode = 'books' AND status = 'completed';

CREATE TRIGGER typing_sessions_no_delete BEFORE DELETE ON typing_sessions
BEGIN SELECT RAISE(ABORT, 'typing_sessions is append-only'); END;
CREATE TRIGGER typing_sessions_frozen BEFORE UPDATE ON typing_sessions
WHEN OLD.status <> 'active'
BEGIN SELECT RAISE(ABORT, 'a finished typing session never changes'); END;
CREATE TRIGGER typing_sessions_identity BEFORE UPDATE ON typing_sessions
WHEN NEW.id IS NOT OLD.id OR NEW.mode IS NOT OLD.mode OR NEW.level_number IS NOT OLD.level_number
  OR NEW.settings_revision IS NOT OLD.settings_revision OR NEW.settings_json IS NOT OLD.settings_json OR NEW.plan_json IS NOT OLD.plan_json
  OR NEW.started_at IS NOT OLD.started_at OR NEW.book_id IS NOT OLD.book_id
  OR NEW.start_offset IS NOT OLD.start_offset OR NEW.end_offset IS NOT OLD.end_offset
  OR NEW.active_ms < OLD.active_ms OR NEW.chars_typed < OLD.chars_typed OR NEW.errors < OLD.errors
BEGIN SELECT RAISE(ABORT, 'typing_sessions: identity is fixed and counters only grow'); END;

CREATE TABLE typing_words (
  id                  TEXT PRIMARY KEY NOT NULL,
  session_id          TEXT NOT NULL REFERENCES typing_sessions(id) ON DELETE RESTRICT,
  plan_index          INTEGER NOT NULL CHECK (plan_index >= 0),
  appearance_order    INTEGER NOT NULL CHECK (appearance_order >= 0),
  lemma               TEXT NOT NULL,
  source              TEXT NOT NULL CHECK (source IN ('general','vocabulary')),
  vocabulary_entry_id TEXT REFERENCES vocabulary_entries(id) ON DELETE RESTRICT,
  shown_at            TEXT NOT NULL,
  destroyed_at        TEXT,
  UNIQUE (session_id, plan_index),
  UNIQUE (session_id, appearance_order),
  CHECK ((source = 'vocabulary') = (vocabulary_entry_id IS NOT NULL))
);
CREATE INDEX typing_words_entry ON typing_words(vocabulary_entry_id, shown_at);
CREATE TRIGGER typing_words_no_delete BEFORE DELETE ON typing_words
BEGIN SELECT RAISE(ABORT, 'typing_words is append-only'); END;
-- the only change ever allowed: destroyed_at from NULL to a value
CREATE TRIGGER typing_words_guard BEFORE UPDATE ON typing_words
WHEN OLD.destroyed_at IS NOT NULL OR NEW.destroyed_at IS NULL
  OR NEW.id IS NOT OLD.id OR NEW.session_id IS NOT OLD.session_id OR NEW.plan_index IS NOT OLD.plan_index
  OR NEW.appearance_order IS NOT OLD.appearance_order OR NEW.lemma IS NOT OLD.lemma OR NEW.source IS NOT OLD.source
  OR NEW.vocabulary_entry_id IS NOT OLD.vocabulary_entry_id OR NEW.shown_at IS NOT OLD.shown_at
BEGIN SELECT RAISE(ABORT, 'typing_words: only destroyed_at may be set, once'); END;

CREATE TABLE typing_xp_events (
  id           TEXT PRIMARY KEY NOT NULL,
  session_id   TEXT NOT NULL UNIQUE REFERENCES typing_sessions(id) ON DELETE RESTRICT,
  amount       INTEGER NOT NULL CHECK (amount > 0),
  rule_version TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE TRIGGER typing_xp_no_update BEFORE UPDATE ON typing_xp_events BEGIN SELECT RAISE(ABORT, 'typing_xp_events is append-only'); END;
CREATE TRIGGER typing_xp_no_delete BEFORE DELETE ON typing_xp_events BEGIN SELECT RAISE(ABORT, 'typing_xp_events is append-only'); END;
CREATE TRIGGER typing_xp_guard BEFORE INSERT ON typing_xp_events
WHEN NOT EXISTS (SELECT 1 FROM typing_sessions s WHERE s.id = NEW.session_id AND s.status = 'completed')
BEGIN SELECT RAISE(ABORT, 'typing XP requires a completed session'); END;
