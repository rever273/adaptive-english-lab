-- Migration 057 (TASK_037, D152-D161): Context Loop vocabulary practice. New tables plus one rebuild of mode_xp_events (new XP source).
-- Sentences are written ahead of time, by the local model (code checks + a model review pass: `validated`, never `approved`) or by a coding agent
-- (code checks + an independent agent reviewer: `approved`). They live in their own tables and never reach the exercise bank, the no-repeat ledger,
-- vocabulary sessions, diagnostics or Mastery. Sentence text is immutable (an edit is a new row); statuses, attempts and time are append-only.
-- No audio is stored; a voice answer keeps only text. Runs inside a runner-managed transaction. Do not edit after it has been applied.
CREATE TABLE context_loop_batches (
  id              TEXT PRIMARY KEY NOT NULL,
  author          TEXT NOT NULL CHECK (author IN ('model','agent')),
  requested_words INTEGER NOT NULL CHECK (requested_words >= 1),
  per_word        INTEGER NOT NULL CHECK (per_word BETWEEN 3 AND 5),
  status          TEXT NOT NULL CHECK (status IN ('generating','awaiting_agent','done','failed')),
  words_json      TEXT NOT NULL CHECK (json_valid(words_json)),
  prompt_version  TEXT NOT NULL,
  model_tag       TEXT,
  -- a machine code only, never text written by a model
  error_code      TEXT,
  receipt_json    TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
  created_at      TEXT NOT NULL,
  finished_at     TEXT,
  CHECK ((status IN ('done','failed')) = (finished_at IS NOT NULL))
);
CREATE INDEX context_loop_batches_status ON context_loop_batches(status, created_at);
CREATE TRIGGER context_loop_batches_no_delete BEFORE DELETE ON context_loop_batches BEGIN SELECT RAISE(ABORT, 'context_loop_batches is never deleted'); END;
CREATE TRIGGER context_loop_batches_identity BEFORE UPDATE ON context_loop_batches
WHEN NEW.id IS NOT OLD.id OR NEW.author IS NOT OLD.author OR NEW.words_json IS NOT OLD.words_json OR NEW.per_word IS NOT OLD.per_word
  OR NEW.created_at IS NOT OLD.created_at OR OLD.status IN ('done','failed')
BEGIN SELECT RAISE(ABORT, 'context_loop_batches: identity is fixed and a finished batch never changes'); END;

CREATE TABLE context_loop_sentences (
  id             TEXT PRIMARY KEY NOT NULL,
  entry_id       TEXT NOT NULL REFERENCES vocabulary_entries(id) ON DELETE RESTRICT,
  lemma          TEXT NOT NULL,
  -- the word facts the sentence was written for (translation, definition, part of speech, forms)
  sense_json     TEXT NOT NULL CHECK (json_valid(sense_json)),
  text           TEXT NOT NULL,
  target_surface TEXT NOT NULL,
  -- found by code, never taken from a model
  target_start   INTEGER NOT NULL CHECK (target_start >= 0),
  target_length  INTEGER NOT NULL CHECK (target_length > 0),
  context_label  TEXT NOT NULL,
  difficulty     TEXT NOT NULL CHECK (difficulty IN ('easy','medium','challenging')),
  fingerprint    TEXT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('model','agent','learner')),
  author_id      TEXT,
  batch_id       TEXT REFERENCES context_loop_batches(id) ON DELETE RESTRICT,
  parent_id      TEXT REFERENCES context_loop_sentences(id) ON DELETE RESTRICT,
  prompt_version TEXT,
  model_tag      TEXT,
  review_json    TEXT CHECK (review_json IS NULL OR json_valid(review_json)),
  created_at     TEXT NOT NULL,
  UNIQUE (entry_id, fingerprint)
);
CREATE INDEX context_loop_sentences_entry ON context_loop_sentences(entry_id);
CREATE TRIGGER context_loop_sentences_no_update BEFORE UPDATE ON context_loop_sentences BEGIN SELECT RAISE(ABORT, 'context_loop_sentences is immutable'); END;
CREATE TRIGGER context_loop_sentences_no_delete BEFORE DELETE ON context_loop_sentences BEGIN SELECT RAISE(ABORT, 'context_loop_sentences is immutable'); END;

-- the latest row decides; practice uses 'validated' and 'approved'
CREATE TABLE context_loop_sentence_status (
  id          TEXT PRIMARY KEY NOT NULL,
  sentence_id TEXT NOT NULL REFERENCES context_loop_sentences(id) ON DELETE RESTRICT,
  status      TEXT NOT NULL CHECK (status IN ('validated','approved','flagged','rejected')),
  actor       TEXT NOT NULL CHECK (actor IN ('code','model','agent','learner')),
  reason      TEXT,
  created_at  TEXT NOT NULL,
  -- only an independent agent review approves
  CHECK (status <> 'approved' OR actor = 'agent')
);
CREATE INDEX context_loop_sentence_status_sentence ON context_loop_sentence_status(sentence_id, created_at);
CREATE TRIGGER context_loop_sentence_status_no_update BEFORE UPDATE ON context_loop_sentence_status BEGIN SELECT RAISE(ABORT, 'context_loop_sentence_status is append-only'); END;
CREATE TRIGGER context_loop_sentence_status_no_delete BEFORE DELETE ON context_loop_sentence_status BEGIN SELECT RAISE(ABORT, 'context_loop_sentence_status is append-only'); END;

-- one practice session; its queue is derived from plan_json and the attempts, never stored as mutable state
CREATE TABLE context_loop_sessions (
  id            TEXT PRIMARY KEY NOT NULL,
  tab_id        TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active','completed')),
  plan_json     TEXT NOT NULL CHECK (json_valid(plan_json)),
  seed          INTEGER NOT NULL,
  queue_version TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  completed_at  TEXT,
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX context_loop_sessions_one_active ON context_loop_sessions(status) WHERE status = 'active';
CREATE TRIGGER context_loop_sessions_no_delete BEFORE DELETE ON context_loop_sessions BEGIN SELECT RAISE(ABORT, 'context_loop_sessions is never deleted'); END;
CREATE TRIGGER context_loop_sessions_frozen BEFORE UPDATE ON context_loop_sessions WHEN OLD.status = 'completed'
BEGIN SELECT RAISE(ABORT, 'a completed context loop session never changes'); END;
CREATE TRIGGER context_loop_sessions_identity BEFORE UPDATE ON context_loop_sessions
WHEN NEW.id IS NOT OLD.id OR NEW.plan_json IS NOT OLD.plan_json OR NEW.seed IS NOT OLD.seed OR NEW.queue_version IS NOT OLD.queue_version OR NEW.started_at IS NOT OLD.started_at
BEGIN SELECT RAISE(ABORT, 'context_loop_sessions: identity is fixed'); END;

-- raw answers: one per place of a session; only text, never audio
CREATE TABLE context_loop_attempts (
  id                TEXT PRIMARY KEY NOT NULL,
  session_id        TEXT NOT NULL REFERENCES context_loop_sessions(id) ON DELETE RESTRICT,
  card_index        INTEGER NOT NULL CHECK (card_index >= 0),
  entry_id          TEXT NOT NULL REFERENCES vocabulary_entries(id) ON DELETE RESTRICT,
  sentence_id       TEXT NOT NULL REFERENCES context_loop_sentences(id) ON DELETE RESTRICT,
  kind              TEXT NOT NULL CHECK (kind IN ('card','check')),
  encounter         INTEGER NOT NULL CHECK (encounter >= 1),
  new_context       INTEGER NOT NULL CHECK (new_context IN (0,1)),
  same_in_session   INTEGER NOT NULL CHECK (same_in_session IN (0,1)),
  outcome           TEXT NOT NULL CHECK (outcome IN ('recalled','not_recalled','correct','incorrect','synonym','skipped')),
  input             TEXT CHECK (input IS NULL OR input IN ('text','voice')),
  answer_text       TEXT,
  asr_text          TEXT,
  asr_edited        INTEGER CHECK (asr_edited IS NULL OR asr_edited IN (0,1)),
  stt_model_id      TEXT REFERENCES model_versions(id) ON DELETE RESTRICT,
  form_match        TEXT CHECK (form_match IS NULL OR form_match IN ('exact','other_form')),
  first_letter_hint INTEGER NOT NULL DEFAULT 0 CHECK (first_letter_hint IN (0,1)),
  aids_json         TEXT NOT NULL CHECK (json_valid(aids_json)),
  rule_version      TEXT NOT NULL,
  local_date        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  UNIQUE (session_id, card_index),
  CHECK ((kind = 'card') = (outcome IN ('recalled','not_recalled'))),
  CHECK ((input = 'voice') = (asr_text IS NOT NULL AND asr_edited IS NOT NULL))
);
CREATE INDEX context_loop_attempts_entry ON context_loop_attempts(entry_id, created_at);
CREATE INDEX context_loop_attempts_sentence ON context_loop_attempts(sentence_id);
CREATE TRIGGER context_loop_attempts_no_update BEFORE UPDATE ON context_loop_attempts BEGIN SELECT RAISE(ABORT, 'context_loop_attempts is append-only'); END;
CREATE TRIGGER context_loop_attempts_no_delete BEFORE DELETE ON context_loop_attempts BEGIN SELECT RAISE(ABORT, 'context_loop_attempts is append-only'); END;

-- measured visible time, for the daily plan and the Journey (never overlaps the other activity tables)
CREATE TABLE context_loop_activity_intervals (
  id          TEXT PRIMARY KEY NOT NULL,
  session_id  TEXT NOT NULL REFERENCES context_loop_sessions(id) ON DELETE RESTRICT,
  tab_id      TEXT NOT NULL,
  start_ms    INTEGER NOT NULL,
  end_ms      INTEGER NOT NULL CHECK (end_ms > start_ms AND end_ms - start_ms <= 15000),
  recorded_at TEXT NOT NULL
);
CREATE INDEX context_loop_activity_time ON context_loop_activity_intervals(start_ms, end_ms);
CREATE INDEX context_loop_activity_session ON context_loop_activity_intervals(session_id);
CREATE TRIGGER context_loop_activity_no_update BEFORE UPDATE ON context_loop_activity_intervals BEGIN SELECT RAISE(ABORT, 'context loop activity is immutable'); END;
CREATE TRIGGER context_loop_activity_no_delete BEFORE DELETE ON context_loop_activity_intervals BEGIN SELECT RAISE(ABORT, 'context loop activity is immutable'); END;

-- mode_xp_events gets the source 'contextLoop'. SQLite cannot change a CHECK, so the table is rebuilt with every row copied unchanged.
DROP TRIGGER mode_xp_no_update;
DROP TRIGGER mode_xp_no_delete;
DROP TRIGGER mode_xp_guard;
CREATE TABLE mode_xp_events_new (
  id           TEXT PRIMARY KEY NOT NULL,
  track        TEXT NOT NULL CHECK (track IN ('grammar','vocabulary','conversation')),
  source       TEXT NOT NULL CHECK (source IN ('grammarCloze','wordLesson','conversation','contextLoop')),
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
)
BEGIN SELECT RAISE(ABORT, 'mode XP requires the matching answer or completed lesson'); END;
