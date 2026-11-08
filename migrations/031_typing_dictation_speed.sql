-- Migration 031 (TASK_028 follow-up, D105): how long the learner actually typed an attempt, so Audio Dictation can show typing speed like the other modes.
-- Two nullable columns on the append-only attempts table (older attempts have none). Runs inside a runner-managed transaction. Do not edit after it has been applied.

ALTER TABLE typing_dictation_attempts ADD COLUMN typing_ms INTEGER CHECK (typing_ms IS NULL OR typing_ms >= 0);
ALTER TABLE typing_dictation_attempts ADD COLUMN keystrokes INTEGER CHECK (keystrokes IS NULL OR keystrokes >= 0);
