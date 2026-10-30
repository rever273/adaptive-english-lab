-- Migration 013: Tutor messages (spec/03, spec/06, spec/08, TASK_016, DECISION_LOG D58).
-- One thread per exercise slot. A message is either the learner's question, the APPROVED rule of the exercise (shown at once, source
-- 'approved_exercise', status approved) or a model DRAFT (source 'model', status draft/validated, never approved). Nothing here is Mastery
-- evidence and nothing is ever edited or deleted. Runs inside a runner-managed transaction. Do not edit after it has been applied.

CREATE TABLE tutor_messages (
  id           TEXT PRIMARY KEY NOT NULL,
  thread_id    TEXT NOT NULL REFERENCES session_slots(id) ON DELETE RESTRICT,
  role         TEXT NOT NULL CHECK (role IN ('user','assistant')),
  kind         TEXT NOT NULL CHECK (kind IN ('why','explain_ru','more_examples','question')),
  source       TEXT NOT NULL CHECK (source IN ('user','approved_exercise','model')),
  text         TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 20000),
  context_json TEXT NOT NULL CHECK (json_valid(context_json)),
  job_id       TEXT REFERENCES jobs(id) ON DELETE RESTRICT,
  status       TEXT NOT NULL CHECK (status IN ('draft','validated','pending_review','approved','flagged','rejected')),
  created_at   TEXT NOT NULL,
  CHECK ((role = 'user') = (source = 'user')),
  CHECK (source <> 'model' OR status IN ('draft','validated')),
  CHECK (source <> 'approved_exercise' OR status = 'approved')
);
CREATE INDEX idx_tutor_messages_thread ON tutor_messages(thread_id, created_at);
CREATE UNIQUE INDEX uq_tutor_model_per_job ON tutor_messages(job_id) WHERE job_id IS NOT NULL;

CREATE TRIGGER tutor_messages_no_update BEFORE UPDATE ON tutor_messages BEGIN SELECT RAISE(ABORT, 'tutor_messages is append-only'); END;
CREATE TRIGGER tutor_messages_no_delete BEFORE DELETE ON tutor_messages BEGIN SELECT RAISE(ABORT, 'tutor_messages is append-only'); END;
