-- Migration 055: per-key facts of Audio Dictation answers, so the Keys analytics (progress heatmap, speed and wrong presses per key) cover dictation too.
-- One row per attempt and letter: hits and misses are derived by the server from the answer against the sentence (letters of words typed
-- right, and letters of the sentence that were typed wrong or left out inside a wrong word); total_ms/timed come from the page (gaps over 2 s skipped).
-- Append-only like the attempts they belong to; older attempts simply have no rows. No existing table is changed.
-- Runs inside a runner-managed transaction. Do not edit after it has been applied. Rollback: restore the pre-migration backup (or drop the table; nothing references it).

CREATE TABLE typing_dictation_keys (
  id         TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES typing_dictation_attempts(id) ON DELETE RESTRICT,
  letter     TEXT NOT NULL CHECK (length(letter) = 1 AND letter BETWEEN 'a' AND 'z'),
  hits       INTEGER NOT NULL CHECK (hits >= 0),
  misses     INTEGER NOT NULL CHECK (misses >= 0),
  total_ms   INTEGER NOT NULL CHECK (total_ms >= 0),
  timed      INTEGER NOT NULL CHECK (timed >= 0),
  UNIQUE (attempt_id, letter)
);
CREATE TRIGGER typing_dictation_keys_no_update BEFORE UPDATE ON typing_dictation_keys BEGIN SELECT RAISE(ABORT, 'typing_dictation_keys is append-only'); END;
CREATE TRIGGER typing_dictation_keys_no_delete BEFORE DELETE ON typing_dictation_keys BEGIN SELECT RAISE(ABORT, 'typing_dictation_keys is append-only'); END;
