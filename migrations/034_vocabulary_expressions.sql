-- Migration 034 (TASK_028 follow-up, D111): expressions, a second part of the dictionary next to the words. New tables only.
-- An expression is a phrase of two to eight words the learner wants to remember in combination ("harsh weather conditions"). It has no practice mode
-- of its own; the local model writes a draft (Russian translation, an example sentence, a short Russian description) and the learner may edit it.
-- Revisions are append-only; a removed expression is hidden by an event, nothing is deleted. Runs inside a runner-managed transaction. Do not edit after it has been applied.

CREATE TABLE vocabulary_expressions (
  id         TEXT PRIMARY KEY NOT NULL,
  phrase     TEXT NOT NULL,
  phrase_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TRIGGER vocabulary_expressions_no_update BEFORE UPDATE ON vocabulary_expressions BEGIN SELECT RAISE(ABORT, 'vocabulary_expressions is immutable'); END;
CREATE TRIGGER vocabulary_expressions_no_delete BEFORE DELETE ON vocabulary_expressions BEGIN SELECT RAISE(ABORT, 'vocabulary_expressions is immutable'); END;

CREATE TABLE vocabulary_expression_events (
  id            TEXT PRIMARY KEY NOT NULL,
  expression_id TEXT NOT NULL REFERENCES vocabulary_expressions(id) ON DELETE RESTRICT,
  kind          TEXT NOT NULL CHECK (kind IN ('removed','restored')),
  created_at    TEXT NOT NULL
);
CREATE INDEX vocabulary_expression_events_expression ON vocabulary_expression_events(expression_id, created_at);
CREATE TRIGGER vocabulary_expression_events_no_update BEFORE UPDATE ON vocabulary_expression_events BEGIN SELECT RAISE(ABORT, 'vocabulary_expression_events is append-only'); END;
CREATE TRIGGER vocabulary_expression_events_no_delete BEFORE DELETE ON vocabulary_expression_events BEGIN SELECT RAISE(ABORT, 'vocabulary_expression_events is append-only'); END;

CREATE TABLE vocabulary_expression_revisions (
  id             TEXT PRIMARY KEY NOT NULL,
  expression_id  TEXT NOT NULL REFERENCES vocabulary_expressions(id) ON DELETE RESTRICT,
  revision       INTEGER NOT NULL CHECK (revision >= 1),
  translation_ru TEXT NOT NULL,
  example_en     TEXT NOT NULL,
  description_ru TEXT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('model','user')),
  status         TEXT NOT NULL CHECK (status IN ('draft','user')),
  job_result_id  TEXT REFERENCES job_results(id) ON DELETE RESTRICT,
  created_at     TEXT NOT NULL,
  UNIQUE (expression_id, revision),
  CHECK ((source = 'model') = (status = 'draft'))
);
CREATE TRIGGER vocabulary_expression_revisions_no_update BEFORE UPDATE ON vocabulary_expression_revisions BEGIN SELECT RAISE(ABORT, 'vocabulary_expression_revisions is append-only'); END;
CREATE TRIGGER vocabulary_expression_revisions_no_delete BEFORE DELETE ON vocabulary_expression_revisions BEGIN SELECT RAISE(ABORT, 'vocabulary_expression_revisions is append-only'); END;
