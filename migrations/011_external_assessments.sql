-- Migration 011: external assessments (spec/03, spec/09, TASK_014 part b, DECISION_LOG D56).
-- A report written by someone else (another tool, a tutor, an earlier assessment) is stored as TEXT plus a normalised, source-linked preview.
-- It is a separate series: it never creates a skill opportunity, never feeds Mastery, selection or any internal number, and its percentages are
-- never added to internal ones. The raw text is immutable; the only change a row can undergo is draft -> approved | rejected (the user's decision).
-- Runs inside a runner-managed transaction. Do not edit after it has been applied: the runner checksums it.

CREATE TABLE external_assessments (
  id                 TEXT PRIMARY KEY NOT NULL,
  source             TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 100),
  assessed_at        TEXT NOT NULL,
  imported_at        TEXT NOT NULL,
  method_version     TEXT NOT NULL CHECK (length(method_version) BETWEEN 1 AND 200),
  model_version      TEXT,
  transcript_quality TEXT NOT NULL CHECK (transcript_quality IN ('unknown','poor','fair','good')),
  format             TEXT NOT NULL CHECK (format IN ('md','json')),
  content_hash       TEXT NOT NULL,
  original_text      TEXT NOT NULL CHECK (length(original_text) <= 1048576),
  normalized_json    TEXT NOT NULL CHECK (json_valid(normalized_json)),
  comparability_json TEXT NOT NULL CHECK (json_valid(comparability_json)),
  status             TEXT NOT NULL CHECK (status IN ('draft','validated','pending_review','approved','flagged','rejected')),
  decided_at         TEXT,
  UNIQUE (source, assessed_at, content_hash)
);
CREATE INDEX external_assessments_assessed ON external_assessments(assessed_at);

CREATE TRIGGER external_assessments_update BEFORE UPDATE ON external_assessments
WHEN NEW.id <> OLD.id OR NEW.source <> OLD.source OR NEW.assessed_at <> OLD.assessed_at OR NEW.imported_at <> OLD.imported_at
  OR NEW.original_text <> OLD.original_text OR NEW.normalized_json <> OLD.normalized_json OR NEW.content_hash <> OLD.content_hash
  OR OLD.status <> 'draft' OR NEW.status NOT IN ('approved','rejected')
BEGIN
  SELECT RAISE(ABORT, 'external_assessments: text is immutable; a draft can only become approved or rejected, once');
END;
CREATE TRIGGER external_assessments_no_delete BEFORE DELETE ON external_assessments BEGIN SELECT RAISE(ABORT, 'external_assessments is append-only'); END;
