-- Migration 015: CEFR level of a saved word (DECISION_LOG D64). The level is an AI DRAFT for the sense in which the learner met the word,
-- written by the vocabulary job (prompt vocabulary-v2). Append-only: the latest row of an entry is shown. Nothing in scoring, selection
-- or Mastery reads this table. Runs inside a runner-managed transaction. Do not edit after it has been applied.

CREATE TABLE vocabulary_levels (
  id             TEXT PRIMARY KEY NOT NULL,
  entry_id       TEXT NOT NULL REFERENCES vocabulary_entries(id) ON DELETE RESTRICT,
  level          TEXT NOT NULL CHECK (level IN ('A1','A2','B1','B2','C1','C2')),
  source         TEXT NOT NULL CHECK (source IN ('model')),
  status         TEXT NOT NULL CHECK (status = 'draft'),
  job_result_id  TEXT REFERENCES job_results(id) ON DELETE RESTRICT,
  created_at     TEXT NOT NULL
);
CREATE INDEX vocabulary_levels_entry ON vocabulary_levels(entry_id, created_at);

CREATE TRIGGER vocabulary_levels_no_update BEFORE UPDATE ON vocabulary_levels BEGIN SELECT RAISE(ABORT, 'vocabulary_levels is append-only'); END;
CREATE TRIGGER vocabulary_levels_no_delete BEFORE DELETE ON vocabulary_levels BEGIN SELECT RAISE(ABORT, 'vocabulary_levels is append-only'); END;
