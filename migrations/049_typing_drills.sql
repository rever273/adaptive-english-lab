-- Migration 049 (TASK_033): Typing → Words gets a second variant, Finger Drills. Additive columns, one index and one trigger replaced.
-- A Drills session stays mode = 'words', so the daily goal, Journey time and XP keep counting both variants as one Words activity;
-- `variant` tells them apart where they must not mix (levels, speed estimate, word ratings, analytics).
-- `type_ms` is the time from the first to the last key of one typed word (Drills only; NULL for Meteor Rain and older rows).
-- Existing rows become 'meteors' through the default. Each variant numbers its own levels, so the "one completed Words level per number"
-- index now includes the variant (existing rows are all 'meteors', so it holds for them as before), and the identity trigger also
-- freezes `variant`. Rollback: restore 026's index and trigger; the new columns can stay (older code ignores them).
-- Runs inside a runner-managed transaction. Do not edit after it has been applied.
ALTER TABLE typing_sessions ADD COLUMN variant TEXT NOT NULL DEFAULT 'meteors' CHECK (variant IN ('meteors','drills'));
ALTER TABLE typing_word_results ADD COLUMN type_ms INTEGER CHECK (type_ms IS NULL OR type_ms >= 0);
CREATE INDEX typing_sessions_variant ON typing_sessions(mode, variant, status, ended_at);

DROP INDEX typing_words_level_once;
CREATE UNIQUE INDEX typing_words_level_once ON typing_sessions(variant, level_number) WHERE mode = 'words' AND status = 'completed';

DROP TRIGGER typing_sessions_identity;
CREATE TRIGGER typing_sessions_identity BEFORE UPDATE ON typing_sessions
WHEN NEW.id IS NOT OLD.id OR NEW.mode IS NOT OLD.mode OR NEW.variant IS NOT OLD.variant OR NEW.level_number IS NOT OLD.level_number
  OR NEW.settings_revision IS NOT OLD.settings_revision OR NEW.settings_json IS NOT OLD.settings_json OR NEW.plan_json IS NOT OLD.plan_json
  OR NEW.started_at IS NOT OLD.started_at OR NEW.book_id IS NOT OLD.book_id
  OR NEW.start_offset IS NOT OLD.start_offset OR NEW.end_offset IS NOT OLD.end_offset
  OR NEW.active_ms < OLD.active_ms OR NEW.chars_typed < OLD.chars_typed OR NEW.errors < OLD.errors
BEGIN SELECT RAISE(ABORT, 'typing_sessions: identity is fixed and counters only grow'); END;
