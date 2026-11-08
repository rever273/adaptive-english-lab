-- Migration 032 (TASK_028 follow-up, D106-D108): letter-pair typing statistics and the vocabulary recall bonus after a Words level. New tables only.
-- Runs inside a runner-managed transaction. Do not edit after it has been applied.

-- Per session and letter pair ("th"): how many times the second letter was typed correctly after the first, the summed time between the two
-- key presses (pauses over 2 s are not counted) and the wrong keys pressed when that letter was expected. Raw facts; weak pairs are derived.
CREATE TABLE typing_key_stats (
  id         TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES typing_sessions(id) ON DELETE RESTRICT,
  pair       TEXT NOT NULL CHECK (length(pair) = 2 AND pair GLOB '[a-z-][a-z-]'),
  count      INTEGER NOT NULL CHECK (count >= 0),
  total_ms   INTEGER NOT NULL CHECK (total_ms >= 0),
  errors     INTEGER NOT NULL CHECK (errors >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (session_id, pair),
  CHECK (count > 0 OR errors > 0)
);
CREATE TRIGGER typing_key_stats_no_update BEFORE UPDATE ON typing_key_stats BEGIN SELECT RAISE(ABORT, 'typing_key_stats is append-only'); END;
CREATE TRIGGER typing_key_stats_no_delete BEFORE DELETE ON typing_key_stats BEGIN SELECT RAISE(ABORT, 'typing_key_stats is append-only'); END;

-- The memory check after a finished Words level: up to three saved words typed from their Russian translation. Not Mastery evidence;
-- it only orders the words shown later and feeds the statistics. points are computed by the server from the raw counts.
CREATE TABLE typing_recall_results (
  id           TEXT PRIMARY KEY NOT NULL,
  session_id   TEXT NOT NULL REFERENCES typing_sessions(id) ON DELETE RESTRICT,
  entry_id     TEXT NOT NULL REFERENCES vocabulary_entries(id) ON DELETE RESTRICT,
  lemma        TEXT NOT NULL,
  letters      INTEGER NOT NULL CHECK (letters > 0),
  correct_keys INTEGER NOT NULL CHECK (correct_keys >= 0),
  wrong_keys   INTEGER NOT NULL CHECK (wrong_keys >= 0),
  hints        INTEGER NOT NULL CHECK (hints >= 0),
  revealed     INTEGER NOT NULL CHECK (revealed IN (0,1)),
  points       INTEGER NOT NULL CHECK (points BETWEEN 0 AND 10),
  rule_version TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (session_id, entry_id)
);
CREATE INDEX typing_recall_results_entry ON typing_recall_results(entry_id, created_at);
CREATE TRIGGER typing_recall_results_no_update BEFORE UPDATE ON typing_recall_results BEGIN SELECT RAISE(ABORT, 'typing_recall_results is append-only'); END;
CREATE TRIGGER typing_recall_results_no_delete BEFORE DELETE ON typing_recall_results BEGIN SELECT RAISE(ABORT, 'typing_recall_results is append-only'); END;
