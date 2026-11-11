-- Migration 046 (TASK_032, D138-D145): Grammar Cloze / Sentence Survival. New tables only.
-- A separate practice mode with its own data: its exercises, planned sentences and answers never reach the exercise bank, the no-repeat ledger,
-- sessions/attempts of the grammar Practice, Mastery, Grammar Level or XP. Imported exercises are `validated` (code checks only) or `flagged`
-- (a heuristic found more than one possible answer); never `approved`. Exercise text is immutable per revision; a changed import adds a revision.
-- Answers, exclusions, planned sentences, analyses and time intervals are append-only history. `UNIQUE (stage, item_id)` makes "a sentence is shown
-- for an answer at most once per stage" a database rule. Skill ids here are plain text checked against content/taxonomy/skill-cards.json (D141).
-- Runs inside a runner-managed transaction. Do not edit after it has been applied.

CREATE TABLE grammar_cloze_sources (
  id         TEXT PRIMARY KEY NOT NULL,
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO grammar_cloze_sources(id, title, created_at) VALUES ('zanichelli', 'Zanichelli grammar exercises (train)', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- one row per import run, so a later import is explained by its diff
CREATE TABLE grammar_cloze_imports (
  id                 TEXT PRIMARY KEY NOT NULL,
  source_id          TEXT NOT NULL REFERENCES grammar_cloze_sources(id) ON DELETE RESTRICT,
  source_sha256      TEXT NOT NULL,
  clean_version      TEXT NOT NULL,
  classifier_version TEXT NOT NULL,
  config_sha256      TEXT NOT NULL,
  summary_json       TEXT NOT NULL CHECK (json_valid(summary_json)),
  created_at         TEXT NOT NULL
);

-- the identity of an exercise; its text lives in revisions. id = '<source>:<sourceIndex>'
CREATE TABLE grammar_cloze_items (
  id                  TEXT PRIMARY KEY NOT NULL,
  source_id           TEXT NOT NULL REFERENCES grammar_cloze_sources(id) ON DELETE RESTRICT,
  source_index        INTEGER NOT NULL CHECK (source_index >= 0),
  current_revision_id TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('validated','flagged','retired')),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (source_id, source_index)
);

CREATE TABLE grammar_cloze_revisions (
  id                 TEXT PRIMARY KEY NOT NULL,
  item_id            TEXT NOT NULL,
  revision_no        INTEGER NOT NULL CHECK (revision_no >= 1),
  content_hash       TEXT NOT NULL,
  gapped_text        TEXT NOT NULL CHECK (instr(gapped_text, '___') > 0),
  solution           TEXT NOT NULL CHECK (length(solution) > 0),
  distractors_json   TEXT NOT NULL CHECK (json_valid(distractors_json) AND json_array_length(distractors_json) BETWEEN 1 AND 3),
  filled_text        TEXT NOT NULL,
  source_topic       TEXT NOT NULL,
  skill_id           TEXT,
  skill_confidence   TEXT NOT NULL CHECK (skill_confidence IN ('exact','general')),
  classifier_version TEXT NOT NULL,
  clean_version      TEXT NOT NULL,
  flag_reasons_json  TEXT NOT NULL CHECK (json_valid(flag_reasons_json)),
  import_id          TEXT NOT NULL REFERENCES grammar_cloze_imports(id) ON DELETE RESTRICT,
  created_at         TEXT NOT NULL,
  UNIQUE (item_id, revision_no),
  CHECK ((skill_id IS NULL) = (skill_confidence = 'general'))
);

-- "L01, L02, ...": the n-th training session of the mode; independent of stages and skills
CREATE TABLE grammar_cloze_sessions (
  id                TEXT PRIMARY KEY NOT NULL,
  level_no          INTEGER NOT NULL UNIQUE CHECK (level_no >= 1),
  stage             INTEGER NOT NULL CHECK (stage >= 1),
  planned_count     INTEGER NOT NULL CHECK (planned_count BETWEEN 1 AND 50),
  status            TEXT NOT NULL CHECK (status IN ('active','completed')),
  algorithm_version TEXT NOT NULL,
  seed              INTEGER NOT NULL,
  settings_revision INTEGER NOT NULL,
  tab_id            TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  completed_at      TEXT,
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX grammar_cloze_one_active ON grammar_cloze_sessions(status) WHERE status = 'active';

-- the plan of a session = the reservation of each sentence for its stage
CREATE TABLE grammar_cloze_session_items (
  session_id     TEXT NOT NULL REFERENCES grammar_cloze_sessions(id) ON DELETE RESTRICT,
  position       INTEGER NOT NULL CHECK (position >= 1),
  item_id        TEXT NOT NULL REFERENCES grammar_cloze_items(id) ON DELETE RESTRICT,
  revision_id    TEXT NOT NULL REFERENCES grammar_cloze_revisions(id) ON DELETE RESTRICT,
  stage          INTEGER NOT NULL CHECK (stage >= 1),
  rule_key       TEXT NOT NULL,
  options_json   TEXT NOT NULL CHECK (json_valid(options_json)),
  first_shown_at TEXT,
  PRIMARY KEY (session_id, position),
  UNIQUE (stage, item_id)
);

-- raw answers: the first (and only) choice per sentence and stage
CREATE TABLE grammar_cloze_attempts (
  id           TEXT PRIMARY KEY NOT NULL,
  session_id   TEXT NOT NULL,
  position     INTEGER NOT NULL,
  item_id      TEXT NOT NULL REFERENCES grammar_cloze_items(id) ON DELETE RESTRICT,
  revision_id  TEXT NOT NULL REFERENCES grammar_cloze_revisions(id) ON DELETE RESTRICT,
  stage        INTEGER NOT NULL CHECK (stage >= 1),
  chosen_text  TEXT NOT NULL,
  correct_text TEXT NOT NULL,
  is_correct   INTEGER NOT NULL CHECK (is_correct IN (0,1)),
  skill_id     TEXT,
  rule_key     TEXT NOT NULL,
  source_topic TEXT NOT NULL,
  response_ms  INTEGER CHECK (response_ms IS NULL OR response_ms BETWEEN 0 AND 3600000),
  answered_at  TEXT NOT NULL,
  FOREIGN KEY (session_id, position) REFERENCES grammar_cloze_session_items(session_id, position) ON DELETE RESTRICT,
  UNIQUE (session_id, position),
  UNIQUE (stage, item_id)
);

-- the learner removed the sentence from every future session and stage; separate from imports, so it survives them
CREATE TABLE grammar_cloze_exclusions (
  item_id         TEXT PRIMARY KEY NOT NULL REFERENCES grammar_cloze_items(id) ON DELETE RESTRICT,
  revision_id     TEXT NOT NULL REFERENCES grammar_cloze_revisions(id) ON DELETE RESTRICT,
  session_id      TEXT REFERENCES grammar_cloze_sessions(id) ON DELETE RESTRICT,
  stage           INTEGER NOT NULL CHECK (stage >= 1),
  answered_before INTEGER NOT NULL CHECK (answered_before IN (0,1)),
  reason          TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  created_at      TEXT NOT NULL
);

-- advisory opinion of the local model on one revision (never changes answers, statistics or statuses)
CREATE TABLE grammar_cloze_ai_analyses (
  id               TEXT PRIMARY KEY NOT NULL,
  revision_id      TEXT NOT NULL REFERENCES grammar_cloze_revisions(id) ON DELETE RESTRICT,
  prompt_version   TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending','done','failed')),
  result_json      TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  model_version_id TEXT REFERENCES model_versions(id) ON DELETE RESTRICT,
  job_result_id    TEXT REFERENCES job_results(id) ON DELETE RESTRICT,
  error_code       TEXT,
  created_at       TEXT NOT NULL,
  finished_at      TEXT,
  CHECK ((status = 'done') = (result_json IS NOT NULL))
);
CREATE UNIQUE INDEX grammar_cloze_ai_one ON grammar_cloze_ai_analyses(revision_id, prompt_version) WHERE status <> 'failed';

CREATE TABLE grammar_cloze_activity_intervals (
  id          TEXT PRIMARY KEY NOT NULL,
  session_id  TEXT NOT NULL REFERENCES grammar_cloze_sessions(id) ON DELETE RESTRICT,
  tab_id      TEXT NOT NULL,
  start_ms    INTEGER NOT NULL,
  end_ms      INTEGER NOT NULL CHECK (end_ms > start_ms AND end_ms - start_ms <= 15000),
  recorded_at TEXT NOT NULL
);
CREATE INDEX grammar_cloze_activity_time ON grammar_cloze_activity_intervals(start_ms, end_ms);
CREATE INDEX grammar_cloze_activity_session ON grammar_cloze_activity_intervals(session_id);

CREATE INDEX grammar_cloze_revisions_item ON grammar_cloze_revisions(item_id);
CREATE INDEX grammar_cloze_attempts_stage ON grammar_cloze_attempts(stage, is_correct);
CREATE INDEX grammar_cloze_items_status ON grammar_cloze_items(status);

-- ------------------------------------------------------------------------------------------------------------ immutability
CREATE TRIGGER grammar_cloze_sources_no_delete BEFORE DELETE ON grammar_cloze_sources BEGIN SELECT RAISE(ABORT, 'grammar_cloze_sources is never deleted'); END;
CREATE TRIGGER grammar_cloze_imports_no_update BEFORE UPDATE ON grammar_cloze_imports BEGIN SELECT RAISE(ABORT, 'grammar_cloze_imports is append-only'); END;
CREATE TRIGGER grammar_cloze_imports_no_delete BEFORE DELETE ON grammar_cloze_imports BEGIN SELECT RAISE(ABORT, 'grammar_cloze_imports is append-only'); END;
CREATE TRIGGER grammar_cloze_revisions_no_update BEFORE UPDATE ON grammar_cloze_revisions BEGIN SELECT RAISE(ABORT, 'grammar_cloze_revisions is immutable'); END;
CREATE TRIGGER grammar_cloze_revisions_no_delete BEFORE DELETE ON grammar_cloze_revisions BEGIN SELECT RAISE(ABORT, 'grammar_cloze_revisions is immutable'); END;
CREATE TRIGGER grammar_cloze_items_no_delete BEFORE DELETE ON grammar_cloze_items BEGIN SELECT RAISE(ABORT, 'grammar_cloze_items is never deleted'); END;
CREATE TRIGGER grammar_cloze_items_identity BEFORE UPDATE ON grammar_cloze_items
WHEN NEW.id IS NOT OLD.id OR NEW.source_id IS NOT OLD.source_id OR NEW.source_index IS NOT OLD.source_index OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'grammar_cloze_items: identity is fixed'); END;
CREATE TRIGGER grammar_cloze_attempts_no_update BEFORE UPDATE ON grammar_cloze_attempts BEGIN SELECT RAISE(ABORT, 'grammar_cloze_attempts is append-only'); END;
CREATE TRIGGER grammar_cloze_attempts_no_delete BEFORE DELETE ON grammar_cloze_attempts BEGIN SELECT RAISE(ABORT, 'grammar_cloze_attempts is append-only'); END;
CREATE TRIGGER grammar_cloze_exclusions_no_update BEFORE UPDATE ON grammar_cloze_exclusions BEGIN SELECT RAISE(ABORT, 'grammar_cloze_exclusions is append-only'); END;
CREATE TRIGGER grammar_cloze_exclusions_no_delete BEFORE DELETE ON grammar_cloze_exclusions BEGIN SELECT RAISE(ABORT, 'grammar_cloze_exclusions is append-only'); END;
CREATE TRIGGER grammar_cloze_sessions_no_delete BEFORE DELETE ON grammar_cloze_sessions BEGIN SELECT RAISE(ABORT, 'grammar_cloze_sessions is never deleted'); END;
CREATE TRIGGER grammar_cloze_sessions_frozen BEFORE UPDATE ON grammar_cloze_sessions WHEN OLD.status = 'completed'
BEGIN SELECT RAISE(ABORT, 'a completed grammar cloze session never changes'); END;
CREATE TRIGGER grammar_cloze_sessions_identity BEFORE UPDATE ON grammar_cloze_sessions
WHEN NEW.id IS NOT OLD.id OR NEW.level_no IS NOT OLD.level_no OR NEW.stage IS NOT OLD.stage OR NEW.planned_count IS NOT OLD.planned_count
  OR NEW.algorithm_version IS NOT OLD.algorithm_version OR NEW.seed IS NOT OLD.seed OR NEW.settings_revision IS NOT OLD.settings_revision OR NEW.started_at IS NOT OLD.started_at
BEGIN SELECT RAISE(ABORT, 'grammar_cloze_sessions: identity is fixed'); END;
CREATE TRIGGER grammar_cloze_session_items_no_delete BEFORE DELETE ON grammar_cloze_session_items BEGIN SELECT RAISE(ABORT, 'grammar_cloze_session_items is never deleted'); END;
CREATE TRIGGER grammar_cloze_session_items_fixed BEFORE UPDATE ON grammar_cloze_session_items
WHEN NEW.session_id IS NOT OLD.session_id OR NEW.position IS NOT OLD.position OR NEW.item_id IS NOT OLD.item_id OR NEW.revision_id IS NOT OLD.revision_id
  OR NEW.stage IS NOT OLD.stage OR NEW.rule_key IS NOT OLD.rule_key OR NEW.options_json IS NOT OLD.options_json OR OLD.first_shown_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'grammar_cloze_session_items: only the first showing time may be set, once'); END;
CREATE TRIGGER grammar_cloze_ai_no_delete BEFORE DELETE ON grammar_cloze_ai_analyses BEGIN SELECT RAISE(ABORT, 'grammar_cloze_ai_analyses is never deleted'); END;
CREATE TRIGGER grammar_cloze_ai_frozen BEFORE UPDATE ON grammar_cloze_ai_analyses WHEN OLD.status IN ('done','failed')
BEGIN SELECT RAISE(ABORT, 'a finished analysis never changes'); END;
CREATE TRIGGER grammar_cloze_activity_no_update BEFORE UPDATE ON grammar_cloze_activity_intervals BEGIN SELECT RAISE(ABORT, 'grammar_cloze_activity_intervals is immutable'); END;
CREATE TRIGGER grammar_cloze_activity_no_delete BEFORE DELETE ON grammar_cloze_activity_intervals BEGIN SELECT RAISE(ABORT, 'grammar_cloze_activity_intervals is immutable'); END;
