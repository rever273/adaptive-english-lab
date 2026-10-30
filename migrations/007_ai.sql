-- Migration 007: AI prompt versions and annotations (spec/03, spec/06, TASK_009, DECISION_LOG D42).
-- AI output is only ever stored as a DRAFT annotation with its provenance; nothing here can confirm a verdict or touch Mastery.
-- jobs.prompt_version_id and assessment_revisions.ai_annotation_id were reserved by D26/D41 and are added now (ALTER ... ADD COLUMN ... REFERENCES).
-- Runs inside a runner-managed transaction. Do not edit after it has been applied: the runner checksums it.

CREATE TABLE prompt_versions (
  id            TEXT PRIMARY KEY NOT NULL,
  schema_hash   TEXT NOT NULL,
  template_hash TEXT NOT NULL,
  purpose       TEXT NOT NULL
);

CREATE TABLE ai_annotations (
  id                  TEXT PRIMARY KEY NOT NULL,
  job_result_id       TEXT NOT NULL REFERENCES job_results(id) ON DELETE RESTRICT,
  attempt_id          TEXT REFERENCES attempts(id) ON DELETE RESTRICT,
  content_revision_id TEXT REFERENCES exercise_revisions(id) ON DELETE RESTRICT,
  status              TEXT NOT NULL CHECK (status IN ('draft','validated','pending_review','approved','flagged','rejected')),
  findings_json       TEXT NOT NULL CHECK (json_valid(findings_json)),
  created_at          TEXT NOT NULL,
  -- an annotation produced by a model can be validated at most: approval is a separate, reviewed event
  CHECK (status IN ('draft','validated'))
);
CREATE INDEX ai_annotations_attempt ON ai_annotations(attempt_id);

ALTER TABLE jobs ADD COLUMN prompt_version_id TEXT REFERENCES prompt_versions(id) ON DELETE RESTRICT;
ALTER TABLE assessment_revisions ADD COLUMN ai_annotation_id TEXT REFERENCES ai_annotations(id) ON DELETE RESTRICT;

CREATE TRIGGER prompt_versions_no_update BEFORE UPDATE ON prompt_versions BEGIN SELECT RAISE(ABORT, 'prompt_versions is append-only'); END;
CREATE TRIGGER prompt_versions_no_delete BEFORE DELETE ON prompt_versions BEGIN SELECT RAISE(ABORT, 'prompt_versions is append-only'); END;
CREATE TRIGGER ai_annotations_no_update BEFORE UPDATE ON ai_annotations BEGIN SELECT RAISE(ABORT, 'ai_annotations is append-only'); END;
CREATE TRIGGER ai_annotations_no_delete BEFORE DELETE ON ai_annotations BEGIN SELECT RAISE(ABORT, 'ai_annotations is append-only'); END;
