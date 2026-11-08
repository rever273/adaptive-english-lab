-- Preserve the old cumulative total without guessing its daily distribution.
CREATE TABLE conversation_activity_baseline (session_id TEXT PRIMARY KEY REFERENCES conversation_sessions(id) ON DELETE RESTRICT, active_ms INTEGER NOT NULL CHECK(active_ms >= 0));
INSERT INTO conversation_activity_baseline SELECT id, active_ms FROM conversation_sessions;
CREATE TABLE conversation_activity_intervals (session_id TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE RESTRICT, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL CHECK(end_ms > start_ms AND end_ms-start_ms <= 15000), PRIMARY KEY(session_id,start_ms));
CREATE INDEX conversation_activity_time ON conversation_activity_intervals(start_ms,end_ms);
CREATE TRIGGER conversation_activity_no_update BEFORE UPDATE ON conversation_activity_intervals BEGIN SELECT RAISE(ABORT, 'conversation activity is immutable'); END;
CREATE TRIGGER conversation_activity_no_delete BEFORE DELETE ON conversation_activity_intervals BEGIN SELECT RAISE(ABORT, 'conversation activity is immutable'); END;
