-- Migration 061 (TASK_038, D163-D174): Vocabulary Typing (fourth Typing block). New tables plus one rebuild of mode_xp_events (new XP source).
-- The mode keeps its own word facts: typing_word_bank is only read (it is replaced by `typing:seed` through DROP/RENAME, so no foreign key points at it;
-- words are referenced by lemma). My Vocabulary (vocabulary_entries), vocabulary-selection-v4, Mastery, the exercise bank and the no-repeat ledger are not touched.
-- Raw decisions, cloze answers, cleanup decisions, sentence statuses and time are append-only; the state of a word and the vocabulary estimate are computed
-- from them on request. Tatoeba sentences are immutable (an imported sentence is never edited). No audio is stored.
-- Rollback note: the migration only adds tables and rebuilds mode_xp_events with every row copied unchanged; to undo it restore the pre-migration backup
-- (the runner makes one) or drop the vocab_typing_* tables and rebuild mode_xp_events with the 057 definition. Runs inside a runner-managed transaction.
-- Do not edit after it has been applied.

-- reference of the mode (rank, band, eligibility); changed only by the scripts `vtyping:prepare`, `vtyping:clean` and `vtyping:import-tatoeba`
CREATE TABLE vocab_typing_lexicon (
  lemma                      TEXT PRIMARY KEY NOT NULL,
  freq_rank                  INTEGER NOT NULL UNIQUE CHECK (freq_rank >= 1),
  band                       INTEGER NOT NULL CHECK (band >= 1),
  eligibility                TEXT NOT NULL DEFAULT 'unreviewed' CHECK (eligibility IN ('unreviewed','keep','needs_review','excluded')),
  exclusion_reason           TEXT,
  primary_translation_ru     TEXT,
  secondary_translations_json TEXT CHECK (secondary_translations_json IS NULL OR json_valid(secondary_translations_json)),
  cleanup_id                 TEXT,
  context_count              INTEGER NOT NULL DEFAULT 0 CHECK (context_count >= 0),
  updated_at                 TEXT NOT NULL
);
CREATE INDEX vocab_typing_lexicon_band ON vocab_typing_lexicon(band, freq_rank);

CREATE TABLE vocab_typing_cleanup_runs (
  id             TEXT PRIMARY KEY NOT NULL,
  mode           TEXT NOT NULL CHECK (mode IN ('dry','apply')),
  params_json    TEXT NOT NULL CHECK (json_valid(params_json)),
  model_tag      TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  totals_json    TEXT CHECK (totals_json IS NULL OR json_valid(totals_json))
);
CREATE TRIGGER vocab_typing_cleanup_runs_no_delete BEFORE DELETE ON vocab_typing_cleanup_runs BEGIN SELECT RAISE(ABORT, 'vocab_typing_cleanup_runs is never deleted'); END;

-- every cleanup decision (by the model, a script or the learner); nothing is ever overwritten, 'restore' and a later run supersede
CREATE TABLE vocab_typing_cleanup (
  id                     TEXT PRIMARY KEY NOT NULL,
  run_id                 TEXT REFERENCES vocab_typing_cleanup_runs(id) ON DELETE RESTRICT,
  lemma                  TEXT NOT NULL,
  actor                  TEXT NOT NULL CHECK (actor IN ('model','learner','script')),
  decision               TEXT NOT NULL CHECK (decision IN ('keep','exclude','needs_review','restore')),
  reason                 TEXT,
  primary_translation_ru TEXT,
  secondary_json         TEXT CHECK (secondary_json IS NULL OR json_valid(secondary_json)),
  confidence             REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  transcription_doubt    INTEGER NOT NULL DEFAULT 0 CHECK (transcription_doubt IN (0,1)),
  model_tag              TEXT,
  prompt_version         TEXT,
  error_code             TEXT,
  created_at             TEXT NOT NULL
);
CREATE INDEX vocab_typing_cleanup_lemma ON vocab_typing_cleanup(lemma, created_at);
CREATE INDEX vocab_typing_cleanup_run ON vocab_typing_cleanup(run_id);
CREATE TRIGGER vocab_typing_cleanup_no_update BEFORE UPDATE ON vocab_typing_cleanup BEGIN SELECT RAISE(ABORT, 'vocab_typing_cleanup is append-only'); END;
CREATE TRIGGER vocab_typing_cleanup_no_delete BEFORE DELETE ON vocab_typing_cleanup BEGIN SELECT RAISE(ABORT, 'vocab_typing_cleanup is append-only'); END;

CREATE TABLE vocab_typing_imports (
  id            TEXT PRIMARY KEY NOT NULL,
  corpus        TEXT NOT NULL,
  version       TEXT NOT NULL,
  inputs_json   TEXT NOT NULL CHECK (json_valid(inputs_json)),
  counts_json   TEXT NOT NULL CHECK (json_valid(counts_json)),
  created_at    TEXT NOT NULL,
  UNIQUE (corpus, version)
);
CREATE TRIGGER vocab_typing_imports_no_update BEFORE UPDATE ON vocab_typing_imports BEGIN SELECT RAISE(ABORT, 'vocab_typing_imports is immutable'); END;
CREATE TRIGGER vocab_typing_imports_no_delete BEFORE DELETE ON vocab_typing_imports BEGIN SELECT RAISE(ABORT, 'vocab_typing_imports is immutable'); END;

CREATE TABLE vocab_typing_sentences (
  id               TEXT PRIMARY KEY NOT NULL,
  source           TEXT NOT NULL CHECK (source IN ('tatoeba')),
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
CREATE TRIGGER vocab_typing_sentences_no_update BEFORE UPDATE ON vocab_typing_sentences BEGIN SELECT RAISE(ABORT, 'vocab_typing_sentences is immutable'); END;
CREATE TRIGGER vocab_typing_sentences_no_delete BEFORE DELETE ON vocab_typing_sentences BEGIN SELECT RAISE(ABORT, 'vocab_typing_sentences is immutable'); END;

CREATE TABLE vocab_typing_sentence_targets (
  sentence_id    TEXT NOT NULL REFERENCES vocab_typing_sentences(id) ON DELETE RESTRICT,
  lemma          TEXT NOT NULL,
  start          INTEGER NOT NULL CHECK (start >= 0),
  length         INTEGER NOT NULL CHECK (length > 0),
  surface        TEXT NOT NULL,
  ambiguous      INTEGER NOT NULL DEFAULT 0 CHECK (ambiguous IN (0,1)),
  rank_for_lemma INTEGER NOT NULL CHECK (rank_for_lemma >= 1),
  PRIMARY KEY (sentence_id, lemma)
);
CREATE INDEX vocab_typing_targets_lemma ON vocab_typing_sentence_targets(lemma, rank_for_lemma);
CREATE TRIGGER vocab_typing_targets_no_update BEFORE UPDATE ON vocab_typing_sentence_targets BEGIN SELECT RAISE(ABORT, 'vocab_typing_sentence_targets is immutable'); END;
CREATE TRIGGER vocab_typing_targets_no_delete BEFORE DELETE ON vocab_typing_sentence_targets BEGIN SELECT RAISE(ABORT, 'vocab_typing_sentence_targets is immutable'); END;

-- the latest row decides (lemma NULL = for every lemma of the sentence); never 'approved' (D166)
CREATE TABLE vocab_typing_sentence_status (
  id          TEXT PRIMARY KEY NOT NULL,
  sentence_id TEXT NOT NULL REFERENCES vocab_typing_sentences(id) ON DELETE RESTRICT,
  lemma       TEXT,
  status      TEXT NOT NULL CHECK (status IN ('validated','flagged','rejected')),
  actor       TEXT NOT NULL CHECK (actor IN ('code','learner')),
  reason      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX vocab_typing_sentence_status_sentence ON vocab_typing_sentence_status(sentence_id, created_at);
CREATE TRIGGER vocab_typing_sentence_status_no_update BEFORE UPDATE ON vocab_typing_sentence_status BEGIN SELECT RAISE(ABORT, 'vocab_typing_sentence_status is append-only'); END;
CREATE TRIGGER vocab_typing_sentence_status_no_delete BEFORE DELETE ON vocab_typing_sentence_status BEGIN SELECT RAISE(ABORT, 'vocab_typing_sentence_status is append-only'); END;

-- one practice session of either stage; its queue is derived from plan_json and the events, never stored as mutable state
CREATE TABLE vocab_typing_sessions (
  id                TEXT PRIMARY KEY NOT NULL,
  stage             TEXT NOT NULL CHECK (stage IN ('screening','learning')),
  status            TEXT NOT NULL CHECK (status IN ('active','completed','abandoned')),
  plan_json         TEXT NOT NULL CHECK (json_valid(plan_json)),
  seed              INTEGER NOT NULL,
  algorithm_version TEXT NOT NULL,
  settings_json     TEXT NOT NULL CHECK (json_valid(settings_json)),
  tab_id            TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  ended_at          TEXT,
  active_ms         INTEGER CHECK (active_ms IS NULL OR active_ms >= 0),
  chars_typed       INTEGER CHECK (chars_typed IS NULL OR chars_typed >= 0),
  errors            INTEGER CHECK (errors IS NULL OR errors >= 0),
  wpm               REAL,
  accuracy          REAL,
  metrics_version   TEXT,
  key_stats_json    TEXT CHECK (key_stats_json IS NULL OR json_valid(key_stats_json)),
  CHECK ((status = 'active') = (ended_at IS NULL))
);
CREATE UNIQUE INDEX vocab_typing_sessions_one_active ON vocab_typing_sessions(stage) WHERE status = 'active';
CREATE TRIGGER vocab_typing_sessions_no_delete BEFORE DELETE ON vocab_typing_sessions BEGIN SELECT RAISE(ABORT, 'vocab_typing_sessions is never deleted'); END;
CREATE TRIGGER vocab_typing_sessions_frozen BEFORE UPDATE ON vocab_typing_sessions WHEN OLD.status <> 'active'
BEGIN SELECT RAISE(ABORT, 'a finished vocabulary typing session never changes'); END;
CREATE TRIGGER vocab_typing_sessions_identity BEFORE UPDATE ON vocab_typing_sessions
WHEN NEW.id IS NOT OLD.id OR NEW.stage IS NOT OLD.stage OR NEW.plan_json IS NOT OLD.plan_json OR NEW.seed IS NOT OLD.seed
  OR NEW.algorithm_version IS NOT OLD.algorithm_version OR NEW.settings_json IS NOT OLD.settings_json OR NEW.started_at IS NOT OLD.started_at
BEGIN SELECT RAISE(ABORT, 'vocab_typing_sessions: identity is fixed'); END;

-- raw decisions of both stages (self-assessments, not checks); idempotent by client_event_id
CREATE TABLE vocab_typing_events (
  id              TEXT PRIMARY KEY NOT NULL,
  client_event_id TEXT NOT NULL UNIQUE,
  session_id      TEXT NOT NULL REFERENCES vocab_typing_sessions(id) ON DELETE RESTRICT,
  lemma           TEXT NOT NULL,
  stage           TEXT NOT NULL CHECK (stage IN ('screening','learning')),
  kind            TEXT NOT NULL CHECK (kind IN ('screen_known','screen_unknown','screen_not_useful','learn_exposure','learn_learned')),
  sentence_id     TEXT REFERENCES vocab_typing_sentences(id) ON DELETE RESTRICT,
  is_probe        INTEGER NOT NULL DEFAULT 0 CHECK (is_probe IN (0,1)),
  -- place of the card in a learning session (one answer per place); NULL in screening
  card_index      INTEGER CHECK (card_index IS NULL OR card_index >= 0),
  typing_json     TEXT NOT NULL CHECK (json_valid(typing_json)),
  local_date      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  CHECK ((stage = 'screening') = (kind LIKE 'screen\_%' ESCAPE '\')),
  CHECK ((stage = 'learning') = (sentence_id IS NOT NULL)),
  CHECK ((stage = 'learning') = (card_index IS NOT NULL))
);
CREATE UNIQUE INDEX vocab_typing_events_one_card ON vocab_typing_events(session_id, card_index) WHERE card_index IS NOT NULL;
CREATE UNIQUE INDEX vocab_typing_events_one_screen ON vocab_typing_events(session_id, lemma) WHERE stage = 'screening';
CREATE INDEX vocab_typing_events_lemma ON vocab_typing_events(lemma, created_at);
CREATE INDEX vocab_typing_events_day ON vocab_typing_events(local_date);
CREATE TRIGGER vocab_typing_events_no_update BEFORE UPDATE ON vocab_typing_events BEGIN SELECT RAISE(ABORT, 'vocab_typing_events is append-only'); END;
CREATE TRIGGER vocab_typing_events_no_delete BEFORE DELETE ON vocab_typing_events BEGIN SELECT RAISE(ABORT, 'vocab_typing_events is append-only'); END;

-- cloze checks of stage 2 (the only input of the FSRS state, D168); only text
CREATE TABLE vocab_typing_reviews (
  id                TEXT PRIMARY KEY NOT NULL,
  client_event_id   TEXT NOT NULL UNIQUE,
  session_id        TEXT NOT NULL REFERENCES vocab_typing_sessions(id) ON DELETE RESTRICT,
  lemma             TEXT NOT NULL,
  card_index        INTEGER NOT NULL CHECK (card_index >= 0),
  sentence_id       TEXT NOT NULL REFERENCES vocab_typing_sentences(id) ON DELETE RESTRICT,
  expected          TEXT NOT NULL,
  answer_text       TEXT,
  outcome           TEXT NOT NULL CHECK (outcome IN ('correct','form_match','typo','incorrect','revealed','skipped')),
  rating            TEXT CHECK (rating IS NULL OR rating IN ('good','again')),
  first_answer_text TEXT,
  algorithm_version TEXT NOT NULL,
  local_date        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  CHECK ((rating IS NULL) = (outcome = 'skipped'))
);
CREATE UNIQUE INDEX vocab_typing_reviews_one_card ON vocab_typing_reviews(session_id, card_index);
CREATE INDEX vocab_typing_reviews_lemma ON vocab_typing_reviews(lemma, created_at);
CREATE INDEX vocab_typing_reviews_day ON vocab_typing_reviews(local_date);
CREATE TRIGGER vocab_typing_reviews_no_update BEFORE UPDATE ON vocab_typing_reviews BEGIN SELECT RAISE(ABORT, 'vocab_typing_reviews is append-only'); END;
CREATE TRIGGER vocab_typing_reviews_no_delete BEFORE DELETE ON vocab_typing_reviews BEGIN SELECT RAISE(ABORT, 'vocab_typing_reviews is append-only'); END;

-- measured visible time, for the daily plan and the Journey (never overlaps the other activity tables)
CREATE TABLE vocab_typing_activity_intervals (
  id          TEXT PRIMARY KEY NOT NULL,
  session_id  TEXT NOT NULL REFERENCES vocab_typing_sessions(id) ON DELETE RESTRICT,
  tab_id      TEXT NOT NULL,
  start_ms    INTEGER NOT NULL,
  end_ms      INTEGER NOT NULL CHECK (end_ms > start_ms AND end_ms - start_ms <= 15000),
  recorded_at TEXT NOT NULL
);
CREATE INDEX vocab_typing_activity_time ON vocab_typing_activity_intervals(start_ms, end_ms);
CREATE INDEX vocab_typing_activity_session ON vocab_typing_activity_intervals(session_id);
CREATE TRIGGER vocab_typing_activity_no_update BEFORE UPDATE ON vocab_typing_activity_intervals BEGIN SELECT RAISE(ABORT, 'vocabulary typing activity is immutable'); END;
CREATE TRIGGER vocab_typing_activity_no_delete BEFORE DELETE ON vocab_typing_activity_intervals BEGIN SELECT RAISE(ABORT, 'vocabulary typing activity is immutable'); END;

-- mode_xp_events gets the source 'vocabTyping'. SQLite cannot change a CHECK, so the table is rebuilt with every row copied unchanged (as in 057).
DROP TRIGGER mode_xp_no_update;
DROP TRIGGER mode_xp_no_delete;
DROP TRIGGER mode_xp_guard;
CREATE TABLE mode_xp_events_new (
  id           TEXT PRIMARY KEY NOT NULL,
  track        TEXT NOT NULL CHECK (track IN ('grammar','vocabulary','conversation')),
  source       TEXT NOT NULL CHECK (source IN ('grammarCloze','wordLesson','conversation','contextLoop','vocabTyping')),
  source_id    TEXT NOT NULL,
  amount       INTEGER NOT NULL CHECK (amount > 0),
  rule_version TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (source, source_id)
);
INSERT INTO mode_xp_events_new(id, track, source, source_id, amount, rule_version, created_at)
  SELECT id, track, source, source_id, amount, rule_version, created_at FROM mode_xp_events;
DROP INDEX mode_xp_events_track;
DROP TABLE mode_xp_events;
ALTER TABLE mode_xp_events_new RENAME TO mode_xp_events;
CREATE INDEX mode_xp_events_track ON mode_xp_events(track, created_at);
CREATE TRIGGER mode_xp_no_update BEFORE UPDATE ON mode_xp_events BEGIN SELECT RAISE(ABORT, 'mode_xp_events is append-only'); END;
CREATE TRIGGER mode_xp_no_delete BEFORE DELETE ON mode_xp_events BEGIN SELECT RAISE(ABORT, 'mode_xp_events is append-only'); END;
CREATE TRIGGER mode_xp_guard BEFORE INSERT ON mode_xp_events
WHEN NOT (
  (NEW.source = 'grammarCloze' AND NEW.track = 'grammar' AND EXISTS (SELECT 1 FROM grammar_cloze_attempts WHERE id = NEW.source_id))
  OR (NEW.source = 'wordLesson' AND NEW.track = 'vocabulary' AND EXISTS (SELECT 1 FROM word_lesson_runs WHERE id = NEW.source_id AND status = 'completed'))
  OR (NEW.source = 'conversation' AND NEW.track = 'conversation' AND EXISTS (SELECT 1 FROM conversation_messages WHERE id = NEW.source_id AND role = 'user'))
  OR (NEW.source = 'contextLoop' AND NEW.track = 'vocabulary' AND EXISTS (SELECT 1 FROM context_loop_attempts WHERE id = NEW.source_id AND outcome IN ('recalled','correct')))
  OR (NEW.source = 'vocabTyping' AND NEW.track = 'vocabulary' AND (
       EXISTS (SELECT 1 FROM vocab_typing_events WHERE id = NEW.source_id AND kind <> 'screen_not_useful')
       OR EXISTS (SELECT 1 FROM vocab_typing_reviews WHERE id = NEW.source_id AND outcome IN ('correct','form_match','typo'))))
)
BEGIN SELECT RAISE(ABORT, 'mode XP requires the matching answer or completed lesson'); END;
