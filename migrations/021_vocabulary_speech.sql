CREATE TABLE vocabulary_speech_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  blocked_until TEXT
);
INSERT INTO vocabulary_speech_settings(id) VALUES (1);
CREATE TABLE vocabulary_speech_requests (
  slot_id TEXT PRIMARY KEY,
  lemma TEXT NOT NULL,
  requested_at TEXT NOT NULL
);
CREATE INDEX vocabulary_speech_requests_time ON vocabulary_speech_requests(requested_at);
