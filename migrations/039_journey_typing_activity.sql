-- Short, dateable observations for the daily plan; existing typing counters remain the source of lifetime totals.
CREATE TABLE journey_typing_intervals (
 id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('words','books','dictation')),
 start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL CHECK(end_ms > start_ms AND end_ms - start_ms <= 15000),
 recorded_at TEXT NOT NULL
);
CREATE INDEX journey_typing_time ON journey_typing_intervals(start_ms,end_ms);
CREATE INDEX journey_typing_session ON journey_typing_intervals(session_id,mode);
CREATE TRIGGER journey_typing_no_update BEFORE UPDATE ON journey_typing_intervals BEGIN SELECT RAISE(ABORT, 'journey intervals are immutable'); END;
CREATE TRIGGER journey_typing_no_delete BEFORE DELETE ON journey_typing_intervals BEGIN SELECT RAISE(ABORT, 'journey intervals are immutable'); END;
