-- Measured practice intervals are separate from answer latency and assessment history.
CREATE TABLE practice_activity_intervals (
 id TEXT PRIMARY KEY NOT NULL,
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
 tab_id TEXT NOT NULL,
 start_ms INTEGER NOT NULL,
 end_ms INTEGER NOT NULL CHECK (end_ms > start_ms AND end_ms - start_ms <= 15000),
 timezone TEXT NOT NULL,
 method TEXT NOT NULL CHECK (method = 'visible-recent-v1'),
 recorded_at TEXT NOT NULL
);
CREATE INDEX practice_activity_time ON practice_activity_intervals(start_ms, end_ms);
CREATE TRIGGER practice_activity_no_update BEFORE UPDATE ON practice_activity_intervals BEGIN SELECT RAISE(ABORT, 'practice activity is immutable'); END;
CREATE TRIGGER practice_activity_no_delete BEFORE DELETE ON practice_activity_intervals BEGIN SELECT RAISE(ABORT, 'practice activity is immutable'); END;
