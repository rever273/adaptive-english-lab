-- Migration 043: results of the matching game that closes a vocabulary practice (word <-> translation pairs). New table only.
-- Raw facts per session and word: how many pairs of this word were matched, how many were needed (1 or 5) and how many wrong pairs involved it.
-- NOT Mastery evidence (a pair is picked from a few visible choices): it only makes a word that was missed or left unmatched come up a little more
-- often elsewhere (see learningFactor). Append-only. Runs inside a runner-managed transaction. Do not edit after it has been applied.
CREATE TABLE vocabulary_match_results (
  id           TEXT PRIMARY KEY NOT NULL,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  lemma        TEXT NOT NULL CHECK (length(lemma) > 0),
  mode         TEXT NOT NULL CHECK (mode IN ('once','rush')),
  needed       INTEGER NOT NULL CHECK (needed IN (1,5)),
  matched      INTEGER NOT NULL CHECK (matched >= 0 AND matched <= needed),
  wrong        INTEGER NOT NULL CHECK (wrong >= 0),
  rule_version TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (session_id, lemma)
);
CREATE INDEX vocabulary_match_results_lemma ON vocabulary_match_results(lemma, created_at);
CREATE TRIGGER vocabulary_match_results_no_update BEFORE UPDATE ON vocabulary_match_results BEGIN SELECT RAISE(ABORT, 'vocabulary_match_results is append-only'); END;
CREATE TRIGGER vocabulary_match_results_no_delete BEFORE DELETE ON vocabulary_match_results BEGIN SELECT RAISE(ABORT, 'vocabulary_match_results is append-only'); END;
