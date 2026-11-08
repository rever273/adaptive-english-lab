-- Migration 028: saved vocabulary words the learner actually typed while reading a book. New table only.
-- One row per occurrence in a COMPLETED Books level (text_offset is the absolute offset of the word in the prepared book), derived by the
-- server from the book text and the vocabulary at completion time; a re-completion adds nothing (UNIQUE). It is a separate kind of
-- encounter from the exercise ones (vocabulary_encounters): it never mixes with bank or displayed counts.
-- Runs inside a runner-managed transaction. Do not edit after it has been applied.

CREATE TABLE typing_book_encounters (
  id          TEXT PRIMARY KEY NOT NULL,
  session_id  TEXT NOT NULL REFERENCES typing_sessions(id) ON DELETE RESTRICT,
  entry_id    TEXT NOT NULL REFERENCES vocabulary_entries(id) ON DELETE RESTRICT,
  text_offset INTEGER NOT NULL CHECK (text_offset >= 0),
  created_at  TEXT NOT NULL,
  UNIQUE (session_id, entry_id, text_offset)
);
CREATE INDEX typing_book_encounters_entry ON typing_book_encounters(entry_id);
CREATE TRIGGER typing_book_encounters_no_update BEFORE UPDATE ON typing_book_encounters BEGIN SELECT RAISE(ABORT, 'typing_book_encounters is append-only'); END;
CREATE TRIGGER typing_book_encounters_no_delete BEFORE DELETE ON typing_book_encounters BEGIN SELECT RAISE(ABORT, 'typing_book_encounters is append-only'); END;
