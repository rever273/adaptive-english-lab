-- Migration 054: the repeat count of the matching game's rush mode is a setting now (1-10, default 4; it was fixed at 5).
-- vocabulary_match_results.needed was limited to 1 or 5, so the table is rebuilt with needed 1..10; existing rows are copied unchanged.
-- Nothing references this table. Append-only triggers and the index are recreated. Rollback: restore the pre-migration backup
-- (rows with needed other than 1 or 5 could not be copied back into the old CHECK).
-- Runs inside a runner-managed transaction. Do not edit after it has been applied.
CREATE TABLE vocabulary_match_results_new (
  id           TEXT PRIMARY KEY NOT NULL,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  lemma        TEXT NOT NULL CHECK (length(lemma) > 0),
  mode         TEXT NOT NULL CHECK (mode IN ('once','rush')),
  needed       INTEGER NOT NULL CHECK (needed BETWEEN 1 AND 10),
  matched      INTEGER NOT NULL CHECK (matched >= 0 AND matched <= needed),
  wrong        INTEGER NOT NULL CHECK (wrong >= 0),
  rule_version TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (session_id, lemma)
);
INSERT INTO vocabulary_match_results_new(rowid, id, session_id, lemma, mode, needed, matched, wrong, rule_version, created_at)
  SELECT rowid, id, session_id, lemma, mode, needed, matched, wrong, rule_version, created_at FROM vocabulary_match_results;
DROP TABLE vocabulary_match_results;
ALTER TABLE vocabulary_match_results_new RENAME TO vocabulary_match_results;
CREATE INDEX vocabulary_match_results_lemma ON vocabulary_match_results(lemma, created_at);
CREATE TRIGGER vocabulary_match_results_no_update BEFORE UPDATE ON vocabulary_match_results BEGIN SELECT RAISE(ABORT, 'vocabulary_match_results is append-only'); END;
CREATE TRIGGER vocabulary_match_results_no_delete BEFORE DELETE ON vocabulary_match_results BEGIN SELECT RAISE(ABORT, 'vocabulary_match_results is append-only'); END;
