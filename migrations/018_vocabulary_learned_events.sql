-- Migration 018: when the learner ticks or unticks "Learned" (vocabulary TZ, decision 6). The flag itself stays on vocabulary_entries;
-- this append-only log only records FUTURE switches, so Vocabulary Analytics can draw "marked learned by date" honestly. Flags set before
-- this migration have no known date and are reported as such. Nothing in scoring, selection, XP or Mastery reads this table.
-- Runs inside a runner-managed transaction. Do not edit after it has been applied.

CREATE TABLE vocabulary_learned_events (
  id          TEXT PRIMARY KEY NOT NULL,
  entry_id    TEXT NOT NULL REFERENCES vocabulary_entries(id) ON DELETE RESTRICT,
  learned     INTEGER NOT NULL CHECK (learned IN (0,1)),
  created_at  TEXT NOT NULL
);
CREATE INDEX vocabulary_learned_events_entry ON vocabulary_learned_events(entry_id, created_at);

CREATE TRIGGER vocabulary_learned_events_no_update BEFORE UPDATE ON vocabulary_learned_events BEGIN SELECT RAISE(ABORT, 'vocabulary_learned_events is append-only'); END;
CREATE TRIGGER vocabulary_learned_events_no_delete BEFORE DELETE ON vocabulary_learned_events BEGIN SELECT RAISE(ABORT, 'vocabulary_learned_events is append-only'); END;
