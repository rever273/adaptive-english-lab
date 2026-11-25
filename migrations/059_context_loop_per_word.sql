-- Migration 059 (TASK_037, user decision 2026-11-23): a Context Loop batch may ask for up to 15 sentences per word (was 3-5).
-- SQLite cannot change a CHECK: the batch table is rebuilt with every row copied unchanged. It is referenced by context_loop_sentences, so the
-- runner turns foreign keys off around this migration (legacy_alter_table keeps the children pointing at the name) and checks them before COMMIT.
-- Runs inside a runner-managed transaction. Do not edit after it has been applied.
DROP TRIGGER context_loop_batches_no_delete;
DROP TRIGGER context_loop_batches_identity;
DROP INDEX context_loop_batches_status;
ALTER TABLE context_loop_batches RENAME TO context_loop_batches_old;
CREATE TABLE context_loop_batches (
  id              TEXT PRIMARY KEY NOT NULL,
  author          TEXT NOT NULL CHECK (author IN ('model','agent')),
  requested_words INTEGER NOT NULL CHECK (requested_words >= 1),
  per_word        INTEGER NOT NULL CHECK (per_word BETWEEN 3 AND 15),
  status          TEXT NOT NULL CHECK (status IN ('generating','awaiting_agent','done','failed')),
  words_json      TEXT NOT NULL CHECK (json_valid(words_json)),
  prompt_version  TEXT NOT NULL,
  model_tag       TEXT,
  -- a machine code only, never text written by a model
  error_code      TEXT,
  receipt_json    TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
  created_at      TEXT NOT NULL,
  finished_at     TEXT,
  CHECK ((status IN ('done','failed')) = (finished_at IS NOT NULL))
);
INSERT INTO context_loop_batches(id, author, requested_words, per_word, status, words_json, prompt_version, model_tag, error_code, receipt_json, created_at, finished_at)
  SELECT id, author, requested_words, per_word, status, words_json, prompt_version, model_tag, error_code, receipt_json, created_at, finished_at FROM context_loop_batches_old;
DROP TABLE context_loop_batches_old;
CREATE INDEX context_loop_batches_status ON context_loop_batches(status, created_at);
CREATE TRIGGER context_loop_batches_no_delete BEFORE DELETE ON context_loop_batches BEGIN SELECT RAISE(ABORT, 'context_loop_batches is never deleted'); END;
CREATE TRIGGER context_loop_batches_identity BEFORE UPDATE ON context_loop_batches
WHEN NEW.id IS NOT OLD.id OR NEW.author IS NOT OLD.author OR NEW.words_json IS NOT OLD.words_json OR NEW.per_word IS NOT OLD.per_word
  OR NEW.created_at IS NOT OLD.created_at OR OLD.status IN ('done','failed')
BEGIN SELECT RAISE(ABORT, 'context_loop_batches: identity is fixed and a finished batch never changes'); END;
