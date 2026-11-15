-- Migration 052: more raw facts from Key Builder lessons, for the analytics every typing mode shares.
-- best_char_streak: the longest run of correct keys in the lesson (NULL for lessons before this migration).
-- typing_key_pairs: letter-pair facts of a completed lesson, the same facts typing_key_stats keeps for Words and Books sessions
-- ("th" typed correctly `count` times in `total_ms` of key intervals, `errors` wrong keys when the second letter was expected).
-- Additive only. Rollback: drop typing_key_pairs; the column can stay (older code ignores it).
-- Runs inside a runner-managed transaction. Do not edit after it has been applied.
ALTER TABLE typing_key_lessons ADD COLUMN best_char_streak INTEGER CHECK (best_char_streak IS NULL OR best_char_streak >= 0);

CREATE TABLE typing_key_pairs (
  id        TEXT PRIMARY KEY NOT NULL,
  lesson_id TEXT NOT NULL REFERENCES typing_key_lessons(id) ON DELETE RESTRICT,
  pair      TEXT NOT NULL CHECK (length(pair) = 2 AND pair NOT GLOB '*[^a-z]*'),
  count     INTEGER NOT NULL CHECK (count >= 0),
  total_ms  INTEGER NOT NULL CHECK (total_ms >= 0),
  errors    INTEGER NOT NULL CHECK (errors >= 0),
  UNIQUE (lesson_id, pair)
);
CREATE TRIGGER typing_key_pairs_no_update BEFORE UPDATE ON typing_key_pairs BEGIN SELECT RAISE(ABORT, 'typing_key_pairs is append-only'); END;
CREATE TRIGGER typing_key_pairs_no_delete BEFORE DELETE ON typing_key_pairs BEGIN SELECT RAISE(ABORT, 'typing_key_pairs is append-only'); END;
CREATE TRIGGER typing_key_pairs_guard BEFORE INSERT ON typing_key_pairs
WHEN NOT EXISTS (SELECT 1 FROM typing_key_lessons l WHERE l.id = NEW.lesson_id AND l.status = 'completed')
BEGIN SELECT RAISE(ABORT, 'pair facts require a completed Key Builder lesson'); END;
