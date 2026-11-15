-- Preserve every existing exercise and its dependants while allowing real-speech provenance.
ALTER TABLE typing_dictation_exercises RENAME TO typing_dictation_exercises_old;
CREATE TABLE typing_dictation_exercises (
  id TEXT PRIMARY KEY NOT NULL,
  lesson_id TEXT NOT NULL REFERENCES typing_dictation_lessons(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  text_en TEXT NOT NULL,
  translation_ru TEXT NOT NULL,
  topic TEXT NOT NULL,
  target_skill_id TEXT,
  word_count INTEGER NOT NULL CHECK (word_count > 0),
  fingerprint TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('tts', 'real')),
  voice_id INTEGER CHECK (voice_id BETWEEN 0 AND 9),
  voice_name TEXT,
  length_scale REAL CHECK (length_scale > 0),
  tts_model_sha256 TEXT,
  audio_file TEXT NOT NULL,
  audio_ms INTEGER NOT NULL CHECK (audio_ms > 0),
  asr_model TEXT NOT NULL,
  asr_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'validated'),
  job_result_id TEXT REFERENCES job_results(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  repeat_of TEXT REFERENCES typing_dictation_exercises(id) ON DELETE RESTRICT,
  UNIQUE (lesson_id, ordinal),
  CHECK (source = 'real' OR (voice_id IS NOT NULL AND voice_name IS NOT NULL AND length_scale IS NOT NULL AND tts_model_sha256 IS NOT NULL))
);
INSERT INTO typing_dictation_exercises SELECT * FROM typing_dictation_exercises_old;
DROP TABLE typing_dictation_exercises_old;
CREATE TRIGGER typing_dictation_exercises_no_update BEFORE UPDATE ON typing_dictation_exercises BEGIN SELECT RAISE(ABORT, 'typing_dictation_exercises is immutable'); END;
CREATE TRIGGER typing_dictation_exercises_no_delete BEFORE DELETE ON typing_dictation_exercises BEGIN SELECT RAISE(ABORT, 'typing_dictation_exercises is immutable'); END;
CREATE TABLE typing_dictation_real_provenance (
  exercise_id TEXT PRIMARY KEY NOT NULL REFERENCES typing_dictation_exercises(id) ON DELETE RESTRICT,
  corpus TEXT NOT NULL,
  sentence_id TEXT NOT NULL,
  clip_file TEXT NOT NULL,
  audio_sha256 TEXT NOT NULL,
  validation_json TEXT NOT NULL CHECK (json_valid(validation_json)),
  created_at TEXT NOT NULL
);
CREATE TRIGGER typing_dictation_real_provenance_no_update BEFORE UPDATE ON typing_dictation_real_provenance BEGIN SELECT RAISE(ABORT, 'typing_dictation_real_provenance is immutable'); END;
CREATE TRIGGER typing_dictation_real_provenance_no_delete BEFORE DELETE ON typing_dictation_real_provenance BEGIN SELECT RAISE(ABORT, 'typing_dictation_real_provenance is immutable'); END;
CREATE TABLE typing_dictation_real_flags (
  id TEXT PRIMARY KEY NOT NULL,
  exercise_id TEXT NOT NULL REFERENCES typing_dictation_exercises(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('flag', 'unflag')),
  created_at TEXT NOT NULL
);
CREATE TRIGGER typing_dictation_real_flags_no_update BEFORE UPDATE ON typing_dictation_real_flags BEGIN SELECT RAISE(ABORT, 'typing_dictation_real_flags is immutable'); END;
CREATE TRIGGER typing_dictation_real_flags_no_delete BEFORE DELETE ON typing_dictation_real_flags BEGIN SELECT RAISE(ABORT, 'typing_dictation_real_flags is immutable'); END;
