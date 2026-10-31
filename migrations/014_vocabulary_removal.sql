-- Migration 014: hiding a saved word (DECISION_LOG D63). Vocabulary entries are never deleted (012), so "remove" is an append-only event:
-- the latest event of an entry decides whether it is listed. Saving the same word again restores it with its history. Nothing in scoring,
-- selection or Mastery reads this table. Runs inside a runner-managed transaction. Do not edit after it has been applied.

CREATE TABLE vocabulary_entry_events (
  id          TEXT PRIMARY KEY NOT NULL,
  entry_id    TEXT NOT NULL REFERENCES vocabulary_entries(id) ON DELETE RESTRICT,
  kind        TEXT NOT NULL CHECK (kind IN ('removed','restored')),
  created_at  TEXT NOT NULL
);
CREATE INDEX vocabulary_entry_events_entry ON vocabulary_entry_events(entry_id, created_at);

CREATE TRIGGER vocabulary_entry_events_no_update BEFORE UPDATE ON vocabulary_entry_events BEGIN SELECT RAISE(ABORT, 'vocabulary_entry_events is append-only'); END;
CREATE TRIGGER vocabulary_entry_events_no_delete BEFORE DELETE ON vocabulary_entry_events BEGIN SELECT RAISE(ABORT, 'vocabulary_entry_events is append-only'); END;
