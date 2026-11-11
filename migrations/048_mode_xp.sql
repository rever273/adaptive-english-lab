-- Migration 048 (TASK_032 follow-up, D150): activity XP for the practice modes that had none. New table only.
-- Grammar Cloze answers earn Grammar XP, a finished One Word lesson earns Vocabulary XP, every Conversation answer earns Conversation XP (a new track).
-- Like the other XP ledgers it is activity, not a grade: append-only, one row per source, and a row is only accepted next to the thing that earned it.
-- Existing history is not backfilled. Runs inside a runner-managed transaction. Do not edit after it has been applied.
CREATE TABLE mode_xp_events (
  id           TEXT PRIMARY KEY NOT NULL,
  track        TEXT NOT NULL CHECK (track IN ('grammar','vocabulary','conversation')),
  source       TEXT NOT NULL CHECK (source IN ('grammarCloze','wordLesson','conversation')),
  source_id    TEXT NOT NULL,
  amount       INTEGER NOT NULL CHECK (amount > 0),
  rule_version TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (source, source_id)
);
CREATE INDEX mode_xp_events_track ON mode_xp_events(track, created_at);
CREATE TRIGGER mode_xp_no_update BEFORE UPDATE ON mode_xp_events BEGIN SELECT RAISE(ABORT, 'mode_xp_events is append-only'); END;
CREATE TRIGGER mode_xp_no_delete BEFORE DELETE ON mode_xp_events BEGIN SELECT RAISE(ABORT, 'mode_xp_events is append-only'); END;
CREATE TRIGGER mode_xp_guard BEFORE INSERT ON mode_xp_events
WHEN NOT (
  (NEW.source = 'grammarCloze' AND NEW.track = 'grammar' AND EXISTS (SELECT 1 FROM grammar_cloze_attempts WHERE id = NEW.source_id))
  OR (NEW.source = 'wordLesson' AND NEW.track = 'vocabulary' AND EXISTS (SELECT 1 FROM word_lesson_runs WHERE id = NEW.source_id AND status = 'completed'))
  OR (NEW.source = 'conversation' AND NEW.track = 'conversation' AND EXISTS (SELECT 1 FROM conversation_messages WHERE id = NEW.source_id AND role = 'user'))
)
BEGIN SELECT RAISE(ABORT, 'mode XP requires the matching answer or completed lesson'); END;
