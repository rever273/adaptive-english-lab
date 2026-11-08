-- Migration 037 (TASK_029, D122-D128): the Piper voice catalogue, its settings and its evidence in the database. New tables only.
-- tts_voices is the fixed catalogue (the ten speakers of en_AU-librivox-medium); tts_voice_settings holds revisions (the current one is the highest
-- revision of a voice); tts_voice_checks continues the live speech checks of migration 035 (which stays, no longer written); tts_voice_flags is the
-- learner's "Sounds bad" mark (D128); tts_voice_eval_* are the raw results of `npm run voices:evaluate`. Every table is append-only.
-- Seed: the starting weights are the learner's own impression of each voice (2026-11-06): the older-sounding voices start lower. Runs inside a
-- runner-managed transaction. Do not edit after it has been applied.

CREATE TABLE tts_voices (
  key            TEXT PRIMARY KEY NOT NULL,
  engine         TEXT NOT NULL CHECK (engine IN ('piper')),
  model_name     TEXT NOT NULL,
  speaker_id     INTEGER NOT NULL CHECK (speaker_id BETWEEN 0 AND 9),
  name           TEXT NOT NULL UNIQUE,
  gender         TEXT NOT NULL CHECK (gender IN ('male','female')),
  training_hours REAL,
  created_at     TEXT NOT NULL,
  UNIQUE (model_name, speaker_id)
);
CREATE TRIGGER tts_voices_no_update BEFORE UPDATE ON tts_voices BEGIN SELECT RAISE(ABORT, 'tts_voices is append-only'); END;
CREATE TRIGGER tts_voices_no_delete BEFORE DELETE ON tts_voices BEGIN SELECT RAISE(ABORT, 'tts_voices is append-only'); END;

CREATE TABLE tts_voice_settings (
  id                TEXT PRIMARY KEY NOT NULL,
  voice_key         TEXT NOT NULL REFERENCES tts_voices(key),
  revision          INTEGER NOT NULL CHECK (revision >= 1),
  enabled           INTEGER NOT NULL CHECK (enabled IN (0,1)),
  prior_weight      REAL NOT NULL CHECK (prior_weight BETWEEN 0 AND 2),
  length_scale      REAL NOT NULL CHECK (length_scale BETWEEN 0.7 AND 1.8),
  noise_scale       REAL CHECK (noise_scale IS NULL OR noise_scale BETWEEN 0 AND 2),
  noise_w_scale     REAL CHECK (noise_w_scale IS NULL OR noise_w_scale BETWEEN 0 AND 2),
  max_speed_up      REAL NOT NULL DEFAULT 0.2 CHECK (max_speed_up BETWEEN 0 AND 0.3),
  age_group         TEXT NOT NULL CHECK (age_group IN ('adult','mature','elderly')),
  avoid_groups_json TEXT NOT NULL DEFAULT '[]',
  purposes_json     TEXT NOT NULL DEFAULT '["dictation","books","listening"]',
  impression        TEXT,
  source            TEXT NOT NULL CHECK (source IN ('seed','user','evaluation')),
  reason            TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE (voice_key, revision)
);
CREATE INDEX tts_voice_settings_voice ON tts_voice_settings(voice_key, revision);
CREATE TRIGGER tts_voice_settings_no_update BEFORE UPDATE ON tts_voice_settings BEGIN SELECT RAISE(ABORT, 'tts_voice_settings is append-only'); END;
CREATE TRIGGER tts_voice_settings_no_delete BEFORE DELETE ON tts_voice_settings BEGIN SELECT RAISE(ABORT, 'tts_voice_settings is append-only'); END;

CREATE TABLE tts_voice_eval_runs (
  id                   TEXT PRIMARY KEY NOT NULL,
  started_at           TEXT NOT NULL,
  finished_at          TEXT NOT NULL,
  tts_model_sha256     TEXT NOT NULL,
  script_version       INTEGER NOT NULL,
  sentence_set_version INTEGER NOT NULL,
  tools_json           TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('complete','partial'))
);
CREATE TRIGGER tts_voice_eval_runs_no_update BEFORE UPDATE ON tts_voice_eval_runs BEGIN SELECT RAISE(ABORT, 'tts_voice_eval_runs is append-only'); END;
CREATE TRIGGER tts_voice_eval_runs_no_delete BEFORE DELETE ON tts_voice_eval_runs BEGIN SELECT RAISE(ABORT, 'tts_voice_eval_runs is append-only'); END;

CREATE TABLE tts_voice_eval_clips (
  id             TEXT PRIMARY KEY NOT NULL,
  run_id         TEXT NOT NULL REFERENCES tts_voice_eval_runs(id),
  voice_key      TEXT NOT NULL REFERENCES tts_voices(key),
  length_scale   REAL NOT NULL,
  noise_w_scale  REAL,
  sentence_index INTEGER NOT NULL,
  text           TEXT NOT NULL,
  heard_text     TEXT,
  word_errors    INTEGER,
  metrics_json   TEXT NOT NULL
);
CREATE INDEX tts_voice_eval_clips_run ON tts_voice_eval_clips(run_id, voice_key);
CREATE TRIGGER tts_voice_eval_clips_no_update BEFORE UPDATE ON tts_voice_eval_clips BEGIN SELECT RAISE(ABORT, 'tts_voice_eval_clips is append-only'); END;
CREATE TRIGGER tts_voice_eval_clips_no_delete BEFORE DELETE ON tts_voice_eval_clips BEGIN SELECT RAISE(ABORT, 'tts_voice_eval_clips is append-only'); END;

CREATE TABLE tts_voice_checks (
  id            TEXT PRIMARY KEY NOT NULL,
  voice_key     TEXT NOT NULL REFERENCES tts_voices(key),
  purpose       TEXT NOT NULL,
  attempt_group TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('ok','asr_mismatch','wav_invalid','wav_length')),
  heard_text    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX tts_voice_checks_voice ON tts_voice_checks(voice_key, created_at);
CREATE INDEX tts_voice_checks_group ON tts_voice_checks(attempt_group);
CREATE TRIGGER tts_voice_checks_no_update BEFORE UPDATE ON tts_voice_checks BEGIN SELECT RAISE(ABORT, 'tts_voice_checks is append-only'); END;
CREATE TRIGGER tts_voice_checks_no_delete BEFORE DELETE ON tts_voice_checks BEGIN SELECT RAISE(ABORT, 'tts_voice_checks is append-only'); END;

CREATE TABLE tts_voice_flags (
  id          TEXT PRIMARY KEY NOT NULL,
  voice_key   TEXT NOT NULL REFERENCES tts_voices(key),
  purpose     TEXT NOT NULL CHECK (purpose IN ('dictation')),
  exercise_id TEXT NOT NULL REFERENCES typing_dictation_exercises(id),
  action      TEXT NOT NULL CHECK (action IN ('flag','unflag')),
  created_at  TEXT NOT NULL
);
CREATE INDEX tts_voice_flags_exercise ON tts_voice_flags(exercise_id, created_at);
CREATE INDEX tts_voice_flags_voice ON tts_voice_flags(voice_key);
CREATE TRIGGER tts_voice_flags_no_update BEFORE UPDATE ON tts_voice_flags BEGIN SELECT RAISE(ABORT, 'tts_voice_flags is append-only'); END;
CREATE TRIGGER tts_voice_flags_no_delete BEFORE DELETE ON tts_voice_flags BEGIN SELECT RAISE(ABORT, 'tts_voice_flags is append-only'); END;

-- the catalogue and the first revision of every voice (lengthScale as calibrated on 2026-11-04; priors from the learner's impression)
INSERT INTO tts_voices(key, engine, model_name, speaker_id, name, gender, training_hours, created_at) VALUES
  ('piper:en_AU-librivox-medium:0', 'piper', 'en_AU-librivox-medium', 0, 'clancy',  'male',   3.39, '2026-11-06T00:00:00.000Z'),
  ('piper:en_AU-librivox-medium:1', 'piper', 'en_AU-librivox-medium', 1, 'bindi',   'female', 2.16, '2026-11-06T00:00:00.000Z'),
  ('piper:en_AU-librivox-medium:2', 'piper', 'en_AU-librivox-medium', 2, 'marlo',   'female', 1.49, '2026-11-06T00:00:00.000Z'),
  ('piper:en_AU-librivox-medium:3', 'piper', 'en_AU-librivox-medium', 3, 'kirra',   'female', 6.05, '2026-11-06T00:00:00.000Z'),
  ('piper:en_AU-librivox-medium:4', 'piper', 'en_AU-librivox-medium', 4, 'angus',   'male',   1.80, '2026-11-06T00:00:00.000Z'),
  ('piper:en_AU-librivox-medium:5', 'piper', 'en_AU-librivox-medium', 5, 'banjo',   'male',   7.97, '2026-11-06T00:00:00.000Z'),
  ('piper:en_AU-librivox-medium:6', 'piper', 'en_AU-librivox-medium', 6, 'flynn',   'male',   0.58, '2026-11-06T00:00:00.000Z'),
  ('piper:en_AU-librivox-medium:7', 'piper', 'en_AU-librivox-medium', 7, 'matilda', 'female', 3.15, '2026-11-06T00:00:00.000Z'),
  ('piper:en_AU-librivox-medium:8', 'piper', 'en_AU-librivox-medium', 8, 'tully',   'female', 3.57, '2026-11-06T00:00:00.000Z'),
  ('piper:en_AU-librivox-medium:9', 'piper', 'en_AU-librivox-medium', 9, 'willow',  'female', 0.86, '2026-11-06T00:00:00.000Z');

INSERT INTO tts_voice_settings(id, voice_key, revision, enabled, prior_weight, length_scale, max_speed_up, age_group, avoid_groups_json, impression, source, reason, created_at) VALUES
  ('seed-voice-0', 'piper:en_AU-librivox-medium:0', 1, 1, 0.15, 1.39, 0.2, 'adult',   '[]',                             'male; accent unclear (British or Australian) but sounds fine and pleasant', 'seed', 'minimum weight: the model author doubts the accent', '2026-11-06T00:00:00.000Z'),
  ('seed-voice-1', 'piper:en_AU-librivox-medium:1', 1, 1, 0.45, 1.28, 0.2, 'mature',  '["tech","gaming","crypto"]',     'woman about 50 or older, not very pleasant',  'seed', NULL, '2026-11-06T00:00:00.000Z'),
  ('seed-voice-2', 'piper:en_AU-librivox-medium:2', 1, 1, 0.30, 1.10, 0.2, 'elderly', '["tech","gaming","crypto"]',     'grandmother 65 or older, not quite pleasant', 'seed', NULL, '2026-11-06T00:00:00.000Z'),
  ('seed-voice-3', 'piper:en_AU-librivox-medium:3', 1, 1, 0.90, 1.37, 0.2, 'adult',   '[]',                             'low woman''s voice, 40-45',                   'seed', NULL, '2026-11-06T00:00:00.000Z'),
  ('seed-voice-4', 'piper:en_AU-librivox-medium:4', 1, 1, 0.50, 1.27, 0.2, 'elderly', '["tech","gaming","crypto"]',     'man about 60 or older, calm',                 'seed', NULL, '2026-11-06T00:00:00.000Z'),
  ('seed-voice-5', 'piper:en_AU-librivox-medium:5', 1, 1, 1.00, 1.50, 0.2, 'adult',   '[]',                             'man about 45, quite pleasant',                'seed', NULL, '2026-11-06T00:00:00.000Z'),
  ('seed-voice-6', 'piper:en_AU-librivox-medium:6', 1, 1, 0.90, 1.50, 0.2, 'adult',   '[]',                             'man 45+, professional, sounds like a radio announcer', 'seed', NULL, '2026-11-06T00:00:00.000Z'),
  ('seed-voice-7', 'piper:en_AU-librivox-medium:7', 1, 1, 1.00, 1.50, 0.2, 'adult',   '[]',                             'pleasant woman, 30+',                         'seed', NULL, '2026-11-06T00:00:00.000Z'),
  ('seed-voice-8', 'piper:en_AU-librivox-medium:8', 1, 1, 0.60, 1.44, 0.2, 'mature',  '["tech","gaming","crypto"]',     'woman 50+',                                   'seed', NULL, '2026-11-06T00:00:00.000Z'),
  ('seed-voice-9', 'piper:en_AU-librivox-medium:9', 1, 1, 0.30, 1.18, 0.2, 'elderly', '["tech","gaming","crypto"]',     'woman 60+',                                   'seed', NULL, '2026-11-06T00:00:00.000Z');

-- the live checks recorded before this migration (migration 035) continue here; the old table stays as it was
INSERT INTO tts_voice_checks(id, voice_key, purpose, attempt_group, outcome, heard_text, created_at)
  SELECT id, 'piper:en_AU-librivox-medium:' || voice_id, 'dictation', id, outcome, NULL, created_at FROM typing_dictation_voice_checks;
