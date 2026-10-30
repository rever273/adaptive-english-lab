-- Migration 009: advisory signals (D49). A cheap model (Nimble) may attach a HINT to a stored draft for the human reviewer, e.g.
-- "this distractor also reads as correct". A signal is advice about a revision: it has no authority. Nothing in the learning engine,
-- the review state machine, release or Mastery reads this table, and there is deliberately no status/verdict column that could be mistaken
-- for one. Append-only, one signal per (revision, source, prompt version).
-- Runs inside a runner-managed transaction. Do not edit after it has been applied: the runner checksums it.

CREATE TABLE advisory_signals (
  id                TEXT PRIMARY KEY NOT NULL,
  revision_id       TEXT NOT NULL REFERENCES exercise_revisions(id) ON DELETE RESTRICT,
  -- model identity as "tag@digest"; the full model version row is referenced through the job result
  source            TEXT NOT NULL CHECK (length(source) > 0),
  prompt_version_id TEXT NOT NULL REFERENCES prompt_versions(id) ON DELETE RESTRICT,
  job_result_id     TEXT REFERENCES job_results(id) ON DELETE RESTRICT,
  -- per-sentence raw scores the model gave, and the flags derived from them by fixed rules (both are data, not decisions)
  scores_json       TEXT NOT NULL CHECK (json_valid(scores_json)),
  flags_json        TEXT NOT NULL CHECK (json_valid(flags_json)),
  created_at        TEXT NOT NULL,
  UNIQUE (revision_id, source, prompt_version_id)
);
CREATE INDEX advisory_signals_revision ON advisory_signals(revision_id);

CREATE TRIGGER advisory_signals_no_update BEFORE UPDATE ON advisory_signals BEGIN SELECT RAISE(ABORT, 'advisory_signals is append-only'); END;
CREATE TRIGGER advisory_signals_no_delete BEFORE DELETE ON advisory_signals BEGIN SELECT RAISE(ABORT, 'advisory_signals is append-only'); END;
