-- Migration 027: how many wrong keys the learner pressed on each Words meteor (0 = clean, 1, 2+). New table only.
-- Raw per-word facts written once when a Words session ends; word selection and the result view derive their ratings from it.
-- Words of sessions that finished before this migration (or from an older client) simply have no row = unknown.
-- Runs inside a runner-managed transaction. Do not edit after it has been applied.

CREATE TABLE typing_word_results (
  session_id TEXT NOT NULL REFERENCES typing_sessions(id) ON DELETE RESTRICT,
  plan_index INTEGER NOT NULL,
  errors     INTEGER NOT NULL CHECK (errors >= 0),
  PRIMARY KEY (session_id, plan_index),
  FOREIGN KEY (session_id, plan_index) REFERENCES typing_words(session_id, plan_index) ON DELETE RESTRICT
);
CREATE TRIGGER typing_word_results_no_update BEFORE UPDATE ON typing_word_results BEGIN SELECT RAISE(ABORT, 'typing_word_results is append-only'); END;
CREATE TRIGGER typing_word_results_no_delete BEFORE DELETE ON typing_word_results BEGIN SELECT RAISE(ABORT, 'typing_word_results is append-only'); END;
