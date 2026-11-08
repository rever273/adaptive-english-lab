-- Conversation practice is separate from attempts and does not create Mastery evidence.
CREATE TABLE conversation_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  topic TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','paused')),
  tab_id TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  heartbeat_at TEXT,
  active_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  answer_count INTEGER NOT NULL DEFAULT 0 CHECK (answer_count >= 0),
  history_deleted INTEGER NOT NULL DEFAULT 0 CHECK (history_deleted IN (0,1))
);
CREATE INDEX conversation_recent ON conversation_sessions(updated_at DESC);

CREATE TABLE conversation_messages (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  created_at TEXT NOT NULL,
  reply_to TEXT,
  UNIQUE (session_id, id),
  UNIQUE (session_id, reply_to),
  FOREIGN KEY (session_id, reply_to) REFERENCES conversation_messages(session_id, id) ON DELETE CASCADE
);
CREATE INDEX conversation_messages_session ON conversation_messages(session_id, created_at);

CREATE TABLE conversation_analyses (
  message_id TEXT PRIMARY KEY NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','ready','unavailable')),
  text TEXT,
  created_at TEXT NOT NULL
);
