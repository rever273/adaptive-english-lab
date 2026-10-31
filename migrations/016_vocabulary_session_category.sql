-- Vocabulary sessions use the existing event history and reservations.
-- Sessions without a row remain grammar sessions; no historical records are rewritten.
CREATE TABLE vocabulary_sessions (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);

CREATE TRIGGER vocabulary_sessions_no_update BEFORE UPDATE ON vocabulary_sessions
BEGIN SELECT RAISE(ABORT, 'vocabulary_sessions is append-only'); END;
CREATE TRIGGER vocabulary_sessions_no_delete BEFORE DELETE ON vocabulary_sessions
BEGIN SELECT RAISE(ABORT, 'vocabulary_sessions is append-only'); END;
CREATE TRIGGER vocabulary_sessions_practice_only BEFORE INSERT ON vocabulary_sessions
WHEN (SELECT purpose FROM sessions WHERE id = NEW.session_id) IS NOT 'practice'
BEGIN SELECT RAISE(ABORT, 'vocabulary sessions must be practice sessions'); END;

-- Category must be assigned before any answer or event can create evidence.
CREATE TRIGGER vocabulary_sessions_before_activity BEFORE INSERT ON vocabulary_sessions
WHEN EXISTS (SELECT 1 FROM session_events WHERE session_id = NEW.session_id)
  OR EXISTS (SELECT 1 FROM attempts a JOIN session_slots s ON s.id = a.slot_id WHERE s.session_id = NEW.session_id)
BEGIN SELECT RAISE(ABORT, 'vocabulary category must precede activity'); END;
