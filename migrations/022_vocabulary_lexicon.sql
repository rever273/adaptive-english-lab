-- Migration 022: reference facts about a saved word (DECISION_LOG D69). Transcription, a short Russian definition, synonyms and irregular verb forms are
-- written by the vocabulary job (prompt vocabulary-v4) for every saved word, with an optional row of the user's old word list (a local CSV, never
-- imported wholesale) given to the model only as a hint to check. By user decision the corrected model output is taken as the truth for these
-- reference fields (status `validated`: passed schema and code checks, not an agent review); exercises are still reviewed as before.
-- `frequency` comes from the old word list as a plain number, never from the model. Append-only: the latest row of an entry is shown. Nothing in
-- scoring, selection or Mastery reads this table. Runs inside a runner-managed transaction. Do not edit after it has been applied.

CREATE TABLE vocabulary_lexicon (
  id                   TEXT PRIMARY KEY NOT NULL,
  entry_id             TEXT NOT NULL REFERENCES vocabulary_entries(id) ON DELETE RESTRICT,
  transcription        TEXT NOT NULL,
  definition_ru        TEXT NOT NULL,
  synonyms_json        TEXT NOT NULL CHECK (json_valid(synonyms_json)),
  irregular_forms_json TEXT NOT NULL CHECK (json_valid(irregular_forms_json)),
  frequency            REAL,
  hint_used            INTEGER NOT NULL CHECK (hint_used IN (0,1)),
  source               TEXT NOT NULL CHECK (source IN ('model')),
  status               TEXT NOT NULL CHECK (status = 'validated'),
  job_result_id        TEXT REFERENCES job_results(id) ON DELETE RESTRICT,
  created_at           TEXT NOT NULL
);
CREATE INDEX vocabulary_lexicon_entry ON vocabulary_lexicon(entry_id, created_at);

CREATE TRIGGER vocabulary_lexicon_no_update BEFORE UPDATE ON vocabulary_lexicon BEGIN SELECT RAISE(ABORT, 'vocabulary_lexicon is append-only'); END;
CREATE TRIGGER vocabulary_lexicon_no_delete BEFORE DELETE ON vocabulary_lexicon BEGIN SELECT RAISE(ABORT, 'vocabulary_lexicon is append-only'); END;
