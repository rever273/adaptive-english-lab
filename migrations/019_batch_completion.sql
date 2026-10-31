-- Keep generation records intact; a completion adds a final outcome for every ordinal.
CREATE TABLE batch_completions (
  batch_id TEXT PRIMARY KEY REFERENCES batches(id) ON DELETE RESTRICT,
  input_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at TEXT NOT NULL
);
CREATE TABLE batch_outcomes (
  batch_id TEXT NOT NULL REFERENCES batch_completions(batch_id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL,
  original_revision_id TEXT REFERENCES exercise_revisions(id) ON DELETE RESTRICT,
  final_revision_id TEXT REFERENCES exercise_revisions(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('keep','replace','reject')),
  reason TEXT NOT NULL,
  author TEXT NOT NULL,
  PRIMARY KEY(batch_id, ordinal),
  FOREIGN KEY(batch_id, ordinal) REFERENCES batch_items(batch_id, ordinal)
);
CREATE TRIGGER batch_completions_no_update BEFORE UPDATE ON batch_completions BEGIN SELECT RAISE(ABORT, 'batch_completions is append-only'); END;
CREATE TRIGGER batch_completions_no_delete BEFORE DELETE ON batch_completions BEGIN SELECT RAISE(ABORT, 'batch_completions is append-only'); END;
CREATE TRIGGER batch_outcomes_no_update BEFORE UPDATE ON batch_outcomes BEGIN SELECT RAISE(ABORT, 'batch_outcomes is append-only'); END;
CREATE TRIGGER batch_outcomes_no_delete BEFORE DELETE ON batch_outcomes BEGIN SELECT RAISE(ABORT, 'batch_outcomes is append-only'); END;
