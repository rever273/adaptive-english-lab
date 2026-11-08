-- Migration 029 (TASK_028, D81-D98): audio dictation. New tables only.
-- Sentences are written by the local model and pass code checks only (status validated, never approved); they never reach the exercise bank or Mastery.
-- Runs inside a runner-managed transaction. Do not edit after it has been applied.

CREATE TABLE typing_dictation_lessons (
  id                 TEXT PRIMARY KEY NOT NULL,
  level_number       INTEGER NOT NULL UNIQUE CHECK (level_number >= 1),
  status             TEXT NOT NULL CHECK (status IN ('generating','ready','failed','completed')),
  exercise_count     INTEGER NOT NULL CHECK (exercise_count BETWEEN 5 AND 20),
  settings_revision  INTEGER NOT NULL,
  settings_json      TEXT NOT NULL CHECK (json_valid(settings_json)),
  plan_json          TEXT NOT NULL CHECK (json_valid(plan_json)),
  generation_attempt INTEGER NOT NULL DEFAULT 1 CHECK (generation_attempt >= 1),
  active_ms          INTEGER NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  created_at         TEXT NOT NULL,
  started_at         TEXT,
  completed_at       TEXT,
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX typing_dictation_one_open ON typing_dictation_lessons((status <> 'completed')) WHERE status <> 'completed';
CREATE TRIGGER typing_dictation_lessons_no_delete BEFORE DELETE ON typing_dictation_lessons
BEGIN SELECT RAISE(ABORT, 'typing_dictation_lessons is append-only'); END;
CREATE TRIGGER typing_dictation_lessons_frozen BEFORE UPDATE ON typing_dictation_lessons
WHEN OLD.status = 'completed'
BEGIN SELECT RAISE(ABORT, 'a completed dictation lesson never changes'); END;
CREATE TRIGGER typing_dictation_lessons_identity BEFORE UPDATE ON typing_dictation_lessons
WHEN NEW.id IS NOT OLD.id OR NEW.level_number IS NOT OLD.level_number OR NEW.exercise_count IS NOT OLD.exercise_count
  OR NEW.settings_revision IS NOT OLD.settings_revision OR NEW.settings_json IS NOT OLD.settings_json OR NEW.plan_json IS NOT OLD.plan_json
  OR NEW.created_at IS NOT OLD.created_at OR NEW.active_ms < OLD.active_ms OR NEW.generation_attempt < OLD.generation_attempt
  OR (OLD.started_at IS NOT NULL AND NEW.started_at IS NOT OLD.started_at)
BEGIN SELECT RAISE(ABORT, 'typing_dictation_lessons: identity is fixed and counters only grow'); END;

CREATE TABLE typing_dictation_exercises (
  id               TEXT PRIMARY KEY NOT NULL,
  lesson_id        TEXT NOT NULL REFERENCES typing_dictation_lessons(id) ON DELETE RESTRICT,
  ordinal          INTEGER NOT NULL CHECK (ordinal >= 0),
  text_en          TEXT NOT NULL,
  translation_ru   TEXT NOT NULL,
  topic            TEXT NOT NULL,
  target_skill_id  TEXT,
  word_count       INTEGER NOT NULL CHECK (word_count > 0),
  fingerprint      TEXT NOT NULL UNIQUE,
  source           TEXT NOT NULL CHECK (source = 'tts'),
  voice_id         INTEGER CHECK (voice_id BETWEEN 0 AND 9),
  voice_name       TEXT,
  length_scale     REAL CHECK (length_scale > 0),
  tts_model_sha256 TEXT,
  audio_file       TEXT NOT NULL,
  audio_ms         INTEGER NOT NULL CHECK (audio_ms > 0),
  -- the Whisper check that let this audio in (D97)
  asr_model        TEXT NOT NULL,
  asr_text         TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status = 'validated'),
  job_result_id    TEXT REFERENCES job_results(id) ON DELETE RESTRICT,
  created_at       TEXT NOT NULL,
  UNIQUE (lesson_id, ordinal),
  CHECK (voice_id IS NOT NULL AND voice_name IS NOT NULL AND length_scale IS NOT NULL AND tts_model_sha256 IS NOT NULL)
);
CREATE TRIGGER typing_dictation_exercises_no_update BEFORE UPDATE ON typing_dictation_exercises BEGIN SELECT RAISE(ABORT, 'typing_dictation_exercises is immutable'); END;
CREATE TRIGGER typing_dictation_exercises_no_delete BEFORE DELETE ON typing_dictation_exercises BEGIN SELECT RAISE(ABORT, 'typing_dictation_exercises is immutable'); END;

-- raw attempts, as typed
CREATE TABLE typing_dictation_attempts (
  id               TEXT PRIMARY KEY NOT NULL,  -- the client's idempotency id
  exercise_id      TEXT NOT NULL REFERENCES typing_dictation_exercises(id) ON DELETE RESTRICT,
  attempt_no       INTEGER NOT NULL CHECK (attempt_no >= 1),
  answer_text      TEXT NOT NULL,
  correct          INTEGER NOT NULL CHECK (correct IN (0,1)),
  word_errors      INTEGER NOT NULL CHECK (word_errors >= 0),
  hint_level       INTEGER NOT NULL CHECK (hint_level BETWEEN 0 AND 3),
  translation_seen INTEGER NOT NULL CHECK (translation_seen IN (0,1)),
  check_version    TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE (exercise_id, attempt_no)
);
CREATE UNIQUE INDEX typing_dictation_one_correct ON typing_dictation_attempts(exercise_id) WHERE correct = 1;
CREATE TRIGGER typing_dictation_attempts_no_update BEFORE UPDATE ON typing_dictation_attempts BEGIN SELECT RAISE(ABORT, 'typing_dictation_attempts is append-only'); END;
CREATE TRIGGER typing_dictation_attempts_no_delete BEFORE DELETE ON typing_dictation_attempts BEGIN SELECT RAISE(ABORT, 'typing_dictation_attempts is append-only'); END;
CREATE TRIGGER typing_dictation_attempts_closed BEFORE INSERT ON typing_dictation_attempts
WHEN EXISTS (SELECT 1 FROM typing_dictation_attempts a WHERE a.exercise_id = NEW.exercise_id AND a.correct = 1)
BEGIN SELECT RAISE(ABORT, 'this exercise is already answered correctly'); END;

-- raw help and playback events; the hint level is the count of hint events (3 at most, the service does not write more)
CREATE TABLE typing_dictation_events (
  id          TEXT PRIMARY KEY NOT NULL,
  exercise_id TEXT NOT NULL REFERENCES typing_dictation_exercises(id) ON DELETE RESTRICT,
  kind        TEXT NOT NULL CHECK (kind IN ('play','hint','translation')),
  source      TEXT NOT NULL CHECK (source IN ('auto','manual','wrong_answer')),
  -- hints only: what was in the answer field, and which words (0-based, inclusive) this hint revealed
  typed_text  TEXT,
  reveal_from INTEGER,
  reveal_to   INTEGER,
  created_at  TEXT NOT NULL,
  CHECK ((kind = 'hint') = (typed_text IS NOT NULL)),
  CHECK ((kind = 'hint') = (reveal_from IS NOT NULL AND reveal_to IS NOT NULL AND reveal_from >= 0 AND reveal_to >= reveal_from))
);
CREATE INDEX typing_dictation_events_exercise ON typing_dictation_events(exercise_id, kind);
CREATE TRIGGER typing_dictation_events_no_update BEFORE UPDATE ON typing_dictation_events BEGIN SELECT RAISE(ABORT, 'typing_dictation_events is append-only'); END;
CREATE TRIGGER typing_dictation_events_no_delete BEFORE DELETE ON typing_dictation_events BEGIN SELECT RAISE(ABORT, 'typing_dictation_events is append-only'); END;

CREATE TABLE typing_dictation_xp_events (
  id           TEXT PRIMARY KEY NOT NULL,
  exercise_id  TEXT NOT NULL UNIQUE REFERENCES typing_dictation_exercises(id) ON DELETE RESTRICT,
  amount       INTEGER NOT NULL CHECK (amount > 0),
  coefficient  REAL NOT NULL CHECK (coefficient > 0 AND coefficient <= 1),
  rule_version TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE TRIGGER typing_dictation_xp_no_update BEFORE UPDATE ON typing_dictation_xp_events BEGIN SELECT RAISE(ABORT, 'typing_dictation_xp_events is append-only'); END;
CREATE TRIGGER typing_dictation_xp_no_delete BEFORE DELETE ON typing_dictation_xp_events BEGIN SELECT RAISE(ABORT, 'typing_dictation_xp_events is append-only'); END;
CREATE TRIGGER typing_dictation_xp_guard BEFORE INSERT ON typing_dictation_xp_events
WHEN NOT EXISTS (SELECT 1 FROM typing_dictation_attempts a WHERE a.exercise_id = NEW.exercise_id AND a.correct = 1)
BEGIN SELECT RAISE(ABORT, 'dictation XP requires a correct answer'); END;

CREATE TRIGGER typing_dictation_complete_guard BEFORE UPDATE OF status ON typing_dictation_lessons
WHEN NEW.status = 'completed' AND OLD.status <> 'completed' AND
  (SELECT COUNT(*) FROM typing_dictation_attempts a JOIN typing_dictation_exercises e ON e.id = a.exercise_id WHERE e.lesson_id = NEW.id AND a.correct = 1) < NEW.exercise_count
BEGIN SELECT RAISE(ABORT, 'a dictation lesson completes only when every sentence is correct'); END;
