-- Migration 042: typing_word_bank also serves the word panel's translation lookup, so it now holds every word of the old CSV.
-- Difficulty 1 is allowed; typing_ok marks the rows Typing Words may use (the old rule: lowercase, difficulty >= 2).
-- past_forms / participle_forms: JSON arrays of the irregular verb's 2nd and 3rd forms (arise -> ["arose"] / ["arisen"]), '[]' for other words.
-- Existing rows are copied unchanged. Reference data only; history never references it. Runner-managed transaction.
CREATE TABLE typing_word_bank_new (
  lemma          TEXT PRIMARY KEY NOT NULL CHECK (lemma NOT GLOB '*[^a-z]*' AND length(lemma) BETWEEN 2 AND 32),
  char_count     INTEGER NOT NULL CHECK (char_count = length(lemma)),
  part_of_speech TEXT NOT NULL,
  translation_ru TEXT NOT NULL CHECK (length(translation_ru) > 0),
  definition_ru  TEXT NOT NULL,
  transcription  TEXT NOT NULL,
  difficulty     INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
  status         TEXT NOT NULL CHECK (status = 'draft'),
  source_sha256  TEXT NOT NULL,
  imported_at    TEXT NOT NULL,
  typing_ok      INTEGER NOT NULL DEFAULT 1 CHECK (typing_ok IN (0, 1)),
  past_forms     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(past_forms)),
  participle_forms TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(participle_forms))
);
INSERT INTO typing_word_bank_new(lemma, char_count, part_of_speech, translation_ru, definition_ru, transcription, difficulty, status, source_sha256, imported_at, typing_ok)
  SELECT lemma, char_count, part_of_speech, translation_ru, definition_ru, transcription, difficulty, status, source_sha256, imported_at, 1 FROM typing_word_bank;
DROP TABLE typing_word_bank;
ALTER TABLE typing_word_bank_new RENAME TO typing_word_bank;
CREATE INDEX typing_word_bank_pick ON typing_word_bank(typing_ok, difficulty, char_count);
