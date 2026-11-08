-- Migration 030 (TASK_028 follow-up, D100-D103): prepared dictation tracks, repeats of sentences answered with mistakes, and "show the answer".
-- New tables plus two nullable/defaulted columns; nothing existing is rewritten. Migration 029 stays as it was applied.
-- Runs inside a runner-managed transaction. Do not edit after it has been applied.

-- Voiced and Whisper-checked sentences made ahead of time (the "Prepare tracks" button). A lesson takes the oldest ones first.
CREATE TABLE typing_dictation_pool (
  id                  TEXT PRIMARY KEY NOT NULL,
  text_en             TEXT NOT NULL,
  translation_ru      TEXT NOT NULL,
  topic               TEXT NOT NULL,
  target_skill_id     TEXT,
  vocabulary_entry_id TEXT REFERENCES vocabulary_entries(id) ON DELETE RESTRICT,
  word_count          INTEGER NOT NULL CHECK (word_count > 0),
  fingerprint         TEXT NOT NULL UNIQUE,
  voice_id            INTEGER NOT NULL CHECK (voice_id BETWEEN 0 AND 9),
  voice_name          TEXT NOT NULL,
  length_scale        REAL NOT NULL CHECK (length_scale > 0),
  tts_model_sha256    TEXT NOT NULL,
  audio_file          TEXT NOT NULL,
  audio_ms            INTEGER NOT NULL CHECK (audio_ms > 0),
  asr_model           TEXT NOT NULL,
  asr_text            TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status = 'validated'),
  job_result_id       TEXT REFERENCES job_results(id) ON DELETE RESTRICT,
  created_at          TEXT NOT NULL
);
CREATE TRIGGER typing_dictation_pool_no_update BEFORE UPDATE ON typing_dictation_pool BEGIN SELECT RAISE(ABORT, 'typing_dictation_pool is immutable'); END;
CREATE TRIGGER typing_dictation_pool_no_delete BEFORE DELETE ON typing_dictation_pool BEGIN SELECT RAISE(ABORT, 'typing_dictation_pool is immutable'); END;

-- which prepared sentence became which exercise (a prepared sentence is used once)
CREATE TABLE typing_dictation_pool_use (
  pool_id     TEXT PRIMARY KEY NOT NULL REFERENCES typing_dictation_pool(id) ON DELETE RESTRICT,
  exercise_id TEXT NOT NULL UNIQUE REFERENCES typing_dictation_exercises(id) ON DELETE RESTRICT,
  created_at  TEXT NOT NULL
);
CREATE TRIGGER typing_dictation_pool_use_no_update BEFORE UPDATE ON typing_dictation_pool_use BEGIN SELECT RAISE(ABORT, 'typing_dictation_pool_use is append-only'); END;
CREATE TRIGGER typing_dictation_pool_use_no_delete BEFORE DELETE ON typing_dictation_pool_use BEGIN SELECT RAISE(ABORT, 'typing_dictation_pool_use is append-only'); END;

-- a sentence shown again (marked as a repeat) because it was answered with mistakes before: the exercise it repeats
ALTER TABLE typing_dictation_exercises ADD COLUMN repeat_of TEXT REFERENCES typing_dictation_exercises(id) ON DELETE RESTRICT;

-- "show the whole answer" (F5): a hint event that revealed every word on request; the sentence is then worth no credit
ALTER TABLE typing_dictation_events ADD COLUMN reveal_all INTEGER NOT NULL DEFAULT 0 CHECK (reveal_all IN (0,1));
