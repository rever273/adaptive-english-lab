-- Activity XP is separate from accuracy and Mastery. Existing attempts are not backfilled.
CREATE TABLE activity_xp_events (
  id TEXT PRIMARY KEY NOT NULL,
  slot_id TEXT NOT NULL UNIQUE REFERENCES session_slots(id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL UNIQUE REFERENCES session_events(id) ON DELETE RESTRICT,
  track TEXT NOT NULL CHECK (track IN ('grammar','vocabulary')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  rule_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX activity_xp_events_track ON activity_xp_events(track, created_at);
CREATE TRIGGER activity_xp_no_update BEFORE UPDATE ON activity_xp_events
BEGIN SELECT RAISE(ABORT, 'activity_xp_events is append-only'); END;
CREATE TRIGGER activity_xp_no_delete BEFORE DELETE ON activity_xp_events
BEGIN SELECT RAISE(ABORT, 'activity_xp_events is append-only'); END;
CREATE TRIGGER activity_xp_event_guard BEFORE INSERT ON activity_xp_events
WHEN NOT EXISTS (
  SELECT 1 FROM session_events e JOIN session_slots ss ON ss.id = e.slot_id
  JOIN sessions s ON s.id = ss.session_id
  WHERE e.id = NEW.event_id AND e.slot_id = NEW.slot_id AND e.event_type = 'continue'
    AND s.purpose = 'practice'
    AND EXISTS (SELECT 1 FROM attempts a WHERE a.slot_id = ss.id)
    AND NEW.track = CASE WHEN EXISTS (SELECT 1 FROM vocabulary_sessions v WHERE v.session_id = s.id)
                         THEN 'vocabulary' ELSE 'grammar' END
)
BEGIN SELECT RAISE(ABORT, 'activity XP requires a matching practice completion'); END;
