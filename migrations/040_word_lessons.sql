-- Migration 040 (TASK_031, D129-D136): Single Word Context Practice. New tables only.
-- A lesson is written by the local model and passes code checks plus a model self-review: its status is `validated`, never `approved`. Lessons live in
-- their own tables: they never reach the exercise bank, the no-repeat ledger, vocabulary sessions, Mastery, XP or Vocabulary Level. A lesson becomes
-- `ready` in ONE update after every stage passed; a half-written lesson is never `ready`. Runs, attempts, verdicts, hint events and time intervals are
-- append-only history: a repeated run never overwrites an earlier one. No audio is stored; a voice attempt keeps only text.
-- Runs inside a runner-managed transaction. Do not edit after it has been applied.
CREATE TABLE word_lessons (
  id                 TEXT PRIMARY KEY NOT NULL,
  entry_id           TEXT NOT NULL REFERENCES vocabulary_entries(id) ON DELETE RESTRICT,
  lemma              TEXT NOT NULL,
  sense_json         TEXT NOT NULL CHECK (json_valid(sense_json)),
  plan_json          TEXT NOT NULL CHECK (json_valid(plan_json)),
  status             TEXT NOT NULL CHECK (status IN ('generating','ready','failed')),
  generation_attempt INTEGER NOT NULL DEFAULT 1 CHECK (generation_attempt >= 1),
  content_json       TEXT CHECK (content_json IS NULL OR json_valid(content_json)),
  content_status     TEXT CHECK (content_status IS NULL OR content_status = 'validated'),
  schema_version     TEXT,
  model_version_id   TEXT REFERENCES model_versions(id) ON DELETE RESTRICT,
  job_result_id      TEXT REFERENCES job_results(id) ON DELETE RESTRICT,
  -- a machine code only, never text written by the model
  error_code         TEXT,
  settings_revision  INTEGER NOT NULL,
  created_at         TEXT NOT NULL,
  ready_at           TEXT,
  CHECK ((status = 'ready') = (content_json IS NOT NULL AND content_status = 'validated' AND ready_at IS NOT NULL AND schema_version IS NOT NULL))
);
CREATE UNIQUE INDEX word_lessons_one_ready ON word_lessons(entry_id) WHERE status = 'ready';
CREATE UNIQUE INDEX word_lessons_one_open ON word_lessons(entry_id) WHERE status <> 'ready';
CREATE TRIGGER word_lessons_no_delete BEFORE DELETE ON word_lessons BEGIN SELECT RAISE(ABORT, 'word_lessons is never deleted'); END;
CREATE TRIGGER word_lessons_ready_frozen BEFORE UPDATE ON word_lessons WHEN OLD.status = 'ready'
BEGIN SELECT RAISE(ABORT, 'a ready word lesson never changes'); END;
CREATE TRIGGER word_lessons_identity BEFORE UPDATE ON word_lessons
WHEN NEW.id IS NOT OLD.id OR NEW.entry_id IS NOT OLD.entry_id OR NEW.lemma IS NOT OLD.lemma OR NEW.sense_json IS NOT OLD.sense_json
  OR NEW.plan_json IS NOT OLD.plan_json OR NEW.created_at IS NOT OLD.created_at OR NEW.settings_revision IS NOT OLD.settings_revision
  OR NEW.generation_attempt < OLD.generation_attempt
BEGIN SELECT RAISE(ABORT, 'word_lessons: identity is fixed and the attempt counter only grows'); END;
CREATE TRIGGER word_lessons_transition BEFORE UPDATE ON word_lessons
WHEN NOT ((OLD.status = 'generating' AND NEW.status IN ('ready','failed'))
       OR (OLD.status = 'failed' AND NEW.status = 'generating' AND NEW.generation_attempt = OLD.generation_attempt + 1)
       OR (OLD.status = NEW.status AND OLD.status <> 'ready'))
BEGIN SELECT RAISE(ABORT, 'word_lessons: this status change is not allowed'); END;

-- one pass through a lesson; the lesson is the same every time, only the order of independent examples changes (seed)
CREATE TABLE word_lesson_runs (
  id            TEXT PRIMARY KEY NOT NULL,
  lesson_id     TEXT NOT NULL REFERENCES word_lessons(id) ON DELETE RESTRICT,
  tab_id        TEXT NOT NULL,
  seed          INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active','completed')),
  started_at    TEXT NOT NULL,
  completed_at  TEXT,
  score         INTEGER CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  score_version TEXT,
  score_json    TEXT CHECK (score_json IS NULL OR json_valid(score_json)),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL AND score IS NOT NULL AND score_version IS NOT NULL))
);
CREATE UNIQUE INDEX word_lesson_runs_one_active ON word_lesson_runs(lesson_id) WHERE status = 'active';
CREATE INDEX word_lesson_runs_lesson ON word_lesson_runs(lesson_id, started_at);
CREATE TRIGGER word_lesson_runs_no_delete BEFORE DELETE ON word_lesson_runs BEGIN SELECT RAISE(ABORT, 'word_lesson_runs is never deleted'); END;
CREATE TRIGGER word_lesson_runs_frozen BEFORE UPDATE ON word_lesson_runs WHEN OLD.status = 'completed'
BEGIN SELECT RAISE(ABORT, 'a completed word lesson run never changes'); END;
CREATE TRIGGER word_lesson_runs_identity BEFORE UPDATE ON word_lesson_runs
WHEN NEW.id IS NOT OLD.id OR NEW.lesson_id IS NOT OLD.lesson_id OR NEW.seed IS NOT OLD.seed OR NEW.started_at IS NOT OLD.started_at
BEGIN SELECT RAISE(ABORT, 'word_lesson_runs: identity is fixed'); END;

-- raw answers, as typed (or as confirmed after speech recognition); only text, never audio
CREATE TABLE word_lesson_attempts (
  id           TEXT PRIMARY KEY NOT NULL,
  run_id       TEXT NOT NULL REFERENCES word_lesson_runs(id) ON DELETE RESTRICT,
  item_key     TEXT NOT NULL,
  attempt_no   INTEGER NOT NULL CHECK (attempt_no >= 1),
  answer_text  TEXT NOT NULL,
  input        TEXT NOT NULL CHECK (input IN ('text','voice')),
  asr_text     TEXT,
  edited       INTEGER CHECK (edited IN (0,1)),
  stt_model_id TEXT REFERENCES model_versions(id) ON DELETE RESTRICT,
  created_at   TEXT NOT NULL,
  UNIQUE (run_id, item_key, attempt_no),
  CHECK ((input = 'voice') = (asr_text IS NOT NULL AND edited IS NOT NULL))
);
CREATE INDEX word_lesson_attempts_run ON word_lesson_attempts(run_id, item_key);
CREATE TRIGGER word_lesson_attempts_no_update BEFORE UPDATE ON word_lesson_attempts BEGIN SELECT RAISE(ABORT, 'word_lesson_attempts is append-only'); END;
CREATE TRIGGER word_lesson_attempts_no_delete BEFORE DELETE ON word_lesson_attempts BEGIN SELECT RAISE(ABORT, 'word_lesson_attempts is append-only'); END;

-- the verdicts of one attempt in time order; the highest sequence is the current one (code first, then the model, then a dispute)
CREATE TABLE word_lesson_verdicts (
  id               TEXT PRIMARY KEY NOT NULL,
  attempt_id       TEXT NOT NULL REFERENCES word_lesson_attempts(id) ON DELETE RESTRICT,
  sequence         INTEGER NOT NULL CHECK (sequence >= 1),
  verdict          TEXT NOT NULL CHECK (verdict IN ('correct','incorrect','pending','unresolved','disputed')),
  source           TEXT NOT NULL CHECK (source IN ('code','model','learner')),
  feedback_json    TEXT NOT NULL CHECK (json_valid(feedback_json)),
  model_version_id TEXT REFERENCES model_versions(id) ON DELETE RESTRICT,
  job_result_id    TEXT REFERENCES job_results(id) ON DELETE RESTRICT,
  created_at       TEXT NOT NULL,
  UNIQUE (attempt_id, sequence)
);
CREATE TRIGGER word_lesson_verdicts_no_update BEFORE UPDATE ON word_lesson_verdicts BEGIN SELECT RAISE(ABORT, 'word_lesson_verdicts is append-only'); END;
CREATE TRIGGER word_lesson_verdicts_no_delete BEFORE DELETE ON word_lesson_verdicts BEGIN SELECT RAISE(ABORT, 'word_lesson_verdicts is append-only'); END;

-- hints, the translation button, "continue" after feedback and the end of the passive stage; each at most once per task
CREATE TABLE word_lesson_events (
  id         TEXT PRIMARY KEY NOT NULL,
  run_id     TEXT NOT NULL REFERENCES word_lesson_runs(id) ON DELETE RESTRICT,
  item_key   TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('hint_word','hint_partial','hint_full','translation','hint_start','continue','stage_done')),
  created_at TEXT NOT NULL,
  UNIQUE (run_id, item_key, kind)
);
CREATE TRIGGER word_lesson_events_no_update BEFORE UPDATE ON word_lesson_events BEGIN SELECT RAISE(ABORT, 'word_lesson_events is append-only'); END;
CREATE TRIGGER word_lesson_events_no_delete BEFORE DELETE ON word_lesson_events BEGIN SELECT RAISE(ABORT, 'word_lesson_events is append-only'); END;

-- measured visible time of a lesson, for the daily plan and the Journey (never overlaps the other activity tables)
CREATE TABLE word_lesson_activity_intervals (
  id          TEXT PRIMARY KEY NOT NULL,
  run_id      TEXT NOT NULL REFERENCES word_lesson_runs(id) ON DELETE RESTRICT,
  tab_id      TEXT NOT NULL,
  start_ms    INTEGER NOT NULL,
  end_ms      INTEGER NOT NULL CHECK (end_ms > start_ms AND end_ms - start_ms <= 15000),
  recorded_at TEXT NOT NULL
);
CREATE INDEX word_lesson_activity_time ON word_lesson_activity_intervals(start_ms, end_ms);
CREATE INDEX word_lesson_activity_run ON word_lesson_activity_intervals(run_id);
CREATE TRIGGER word_lesson_activity_no_update BEFORE UPDATE ON word_lesson_activity_intervals BEGIN SELECT RAISE(ABORT, 'word lesson activity is immutable'); END;
CREATE TRIGGER word_lesson_activity_no_delete BEFORE DELETE ON word_lesson_activity_intervals BEGIN SELECT RAISE(ABORT, 'word lesson activity is immutable'); END;
