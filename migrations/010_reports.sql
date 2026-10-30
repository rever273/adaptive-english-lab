-- Migration 010: saved analytics reports (spec/09, TASK_014, DECISION_LOG D54).
-- A report is a DERIVED, replayable summary: every number in it is recomputable from the raw events at the stored watermark. It is stored with
-- its input hash so an identical request returns the identical saved report, and a recalculation after a human correction is a NEW report: old
-- reports are never rewritten or deleted. Nothing here is an input to scoring, selection or Mastery.
-- Runs inside a runner-managed transaction. Do not edit after it has been applied: the runner checksums it.

CREATE TABLE analytics_reports (
  id               TEXT PRIMARY KEY NOT NULL,
  report_version   TEXT NOT NULL,
  config_hash      TEXT NOT NULL,
  as_of            TEXT NOT NULL,
  timezone         TEXT NOT NULL,
  -- JSON {assessments, sessionEvents, errorEvents, reviews}: the rowid watermarks the numbers were computed at
  event_watermark  TEXT NOT NULL CHECK (json_valid(event_watermark)),
  taxonomy_id      TEXT NOT NULL REFERENCES taxonomy_versions(id) ON DELETE RESTRICT,
  cohort_json      TEXT NOT NULL CHECK (json_valid(cohort_json)),
  input_hash       TEXT NOT NULL UNIQUE,
  report_json      TEXT NOT NULL CHECK (json_valid(report_json)),
  created_at       TEXT NOT NULL
);
CREATE INDEX analytics_reports_asof ON analytics_reports(as_of, created_at);

CREATE TRIGGER analytics_reports_no_update BEFORE UPDATE ON analytics_reports BEGIN SELECT RAISE(ABORT, 'analytics_reports is append-only'); END;
CREATE TRIGGER analytics_reports_no_delete BEFORE DELETE ON analytics_reports BEGIN SELECT RAISE(ABORT, 'analytics_reports is append-only'); END;
