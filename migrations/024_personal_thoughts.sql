-- Migration 024 (TASK_026 stage 1): the learner's own Russian thoughts and the analyses made of them. New tables only: no existing table,
-- view or trigger changes. Text is private learner data (git-ignored database); it is never written into exercise revisions.
-- Rollback: DROP TABLE thought_analyses; DROP TABLE personal_thoughts; (nothing else references them).
-- Runs inside a runner-managed transaction. Do not edit after it has been applied.

CREATE TABLE personal_thoughts (
  id         TEXT PRIMARY KEY NOT NULL,
  text_ru    TEXT NOT NULL CHECK (length(text_ru) BETWEEN 1 AND 500),
  text_key   TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- append-only: a new analysis is a new row, an earlier one is never rewritten.
-- pending -> (model read) needs_skills | ambiguous | no_skill | failed; needs_skills -> (agent chose the grammar skills) ok | no_skill
CREATE TABLE thought_analyses (
  id          TEXT PRIMARY KEY NOT NULL,
  thought_id  TEXT NOT NULL REFERENCES personal_thoughts(id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('pending','needs_skills','ok','ambiguous','no_skill','failed')),
  output_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(output_json)),
  batch_id    TEXT REFERENCES batches(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX thought_analyses_thought ON thought_analyses(thought_id);
