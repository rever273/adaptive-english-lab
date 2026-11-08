-- Migration 033 (TASK_028 follow-up, D110): the best combo of a finished Words / Books session (words in a row without a wrong key / characters in a row typed correctly).
-- One nullable column on typing_sessions, written by the completion update; older sessions have none. Runs inside a runner-managed transaction. Do not edit after it has been applied.

ALTER TABLE typing_sessions ADD COLUMN best_combo INTEGER CHECK (best_combo IS NULL OR best_combo >= 0);
