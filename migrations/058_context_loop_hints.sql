-- Migration 058 (TASK_037, D159): the first-letter hint of a Context Loop check is recorded on the server when it is shown, so a reload or a client
-- that forgets the flag cannot turn an assisted answer into an independent one. One row per check card; append-only. New table only.
-- Runs inside a runner-managed transaction. Do not edit after it has been applied.
CREATE TABLE context_loop_hints (
  session_id TEXT NOT NULL REFERENCES context_loop_sessions(id) ON DELETE RESTRICT,
  card_index INTEGER NOT NULL CHECK (card_index >= 0),
  kind       TEXT NOT NULL CHECK (kind = 'first_letter'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, card_index, kind)
);
CREATE TRIGGER context_loop_hints_no_update BEFORE UPDATE ON context_loop_hints BEGIN SELECT RAISE(ABORT, 'context_loop_hints is append-only'); END;
CREATE TRIGGER context_loop_hints_no_delete BEFORE DELETE ON context_loop_hints BEGIN SELECT RAISE(ABORT, 'context_loop_hints is append-only'); END;
