-- Additive Books word observations. Earlier text is unknown, not assumed clean.
CREATE TABLE typing_book_word_tracking (
 session_id TEXT PRIMARY KEY NOT NULL REFERENCES typing_sessions(id) ON DELETE RESTRICT,
 tracked_from INTEGER NOT NULL CHECK(tracked_from >= 0),
 through_offset INTEGER NOT NULL CHECK(through_offset >= 0),
 completed_words INTEGER NOT NULL CHECK(completed_words >= 0),
 error_words INTEGER NOT NULL CHECK(error_words >= 0 AND error_words <= completed_words),
 reliable INTEGER NOT NULL CHECK(reliable IN (0,1))
);
CREATE TABLE typing_book_word_mistakes (
 session_id TEXT NOT NULL REFERENCES typing_sessions(id) ON DELETE RESTRICT,
 token_offset INTEGER NOT NULL CHECK(token_offset >= 0),
 PRIMARY KEY(session_id,token_offset)
);
CREATE TRIGGER typing_book_word_mistakes_no_update BEFORE UPDATE ON typing_book_word_mistakes BEGIN SELECT RAISE(ABORT, 'book word mistakes are immutable'); END;
CREATE TRIGGER typing_book_word_mistakes_no_delete BEFORE DELETE ON typing_book_word_mistakes BEGIN SELECT RAISE(ABORT, 'book word mistakes are immutable'); END;
