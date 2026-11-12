-- Migration 050: Conversation lessons. A conversation is either a free chat on a topic ('topic', every existing row) or a lesson
-- with a teacher ('lesson') on up to three targets: a grammar rule, a saved word, a saved expression. The targets are planned when
-- the lesson starts; `started_at` is set when a target becomes the current one (NULL = still queued). Started targets are the
-- rotation memory: a target is offered again only after the other candidates of its kind have had their turn.
-- Lessons create no Mastery evidence and change no word state, like every conversation (migration 044).
-- Rows survive "Delete text" (they hold no learner text). Rollback: drop the table; the column can stay (older code ignores it).
-- Runs inside a runner-managed transaction. Do not edit after it has been applied.
ALTER TABLE conversation_sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'topic' CHECK (mode IN ('topic','lesson'));

CREATE TABLE conversation_lesson_targets (
  session_id TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 5),
  kind TEXT NOT NULL CHECK (kind IN ('grammar','word','expression')),
  target_key TEXT NOT NULL CHECK (length(target_key) BETWEEN 1 AND 200),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  brief_json TEXT NOT NULL,
  started_at TEXT,
  PRIMARY KEY (session_id, ordinal)
);
CREATE INDEX conversation_lesson_targets_used ON conversation_lesson_targets(kind, target_key, started_at);
