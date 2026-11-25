-- Migration 060 (TASK_037): a Context Loop sentence may carry its Russian translation, written together with the sentence by the local model or the
-- agent and reviewed with it, so the practice shows it without a translation call. Rows stay immutable: existing sentences keep NULL (the learner
-- can still ask for a translation). Column added in place; no row is rewritten.
-- Rollback: restore the pre-migration backup, or ALTER TABLE context_loop_sentences DROP COLUMN translation_ru (SQLite 3.35+; the CHECK is on this column only).
-- Runs inside a runner-managed transaction. Do not edit after it has been applied.
ALTER TABLE context_loop_sentences ADD COLUMN translation_ru TEXT CHECK (translation_ru IS NULL OR length(translation_ru) BETWEEN 1 AND 400);
