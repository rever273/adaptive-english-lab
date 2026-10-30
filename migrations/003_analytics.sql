-- Migration 003: analytics (spec/03, TASK_005, DECISION_LOG D32).
-- Derived data only: runs and snapshots are reproducible from raw events, but saved runs are kept (append-only) so a
-- past report stays reproducible after later corrections; a rebuild creates a new run instead of rewriting one.
-- Runs inside a runner-managed transaction. Do not edit after it has been applied: the runner checksums it.

CREATE TABLE algorithm_versions (
  id             TEXT PRIMARY KEY NOT NULL,
  config_json    TEXT NOT NULL CHECK (json_valid(config_json)),
  config_hash    TEXT NOT NULL UNIQUE,
  source_version TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE analytics_runs (
  id              TEXT PRIMARY KEY NOT NULL,
  algorithm_id    TEXT NOT NULL REFERENCES algorithm_versions(id) ON DELETE RESTRICT,
  -- highest assessment_revisions.rowid included in this run: replays see exactly the same raw events
  event_watermark TEXT NOT NULL,
  as_of           TEXT NOT NULL,
  taxonomy_id     TEXT NOT NULL REFERENCES taxonomy_versions(id) ON DELETE RESTRICT,
  cohort_json     TEXT NOT NULL CHECK (json_valid(cohort_json)),
  input_hash      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (algorithm_id, event_watermark, as_of, taxonomy_id, input_hash)
);
CREATE INDEX analytics_runs_as_of ON analytics_runs(as_of);

CREATE TABLE mastery_snapshots (
  run_id            TEXT NOT NULL REFERENCES analytics_runs(id) ON DELETE RESTRICT,
  skill_id          TEXT NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  dimension         TEXT NOT NULL CHECK (dimension IN ('recognition','correction','production')),
  score             REAL CHECK (score IS NULL OR (score >= 0 AND score <= 10)),
  n                 INTEGER NOT NULL CHECK (n >= 0),
  days              INTEGER NOT NULL CHECK (days >= 0),
  confidence_status TEXT NOT NULL CHECK (confidence_status IN ('unknown','insufficient','developing','stale','stable')),
  components_json   TEXT NOT NULL CHECK (json_valid(components_json)),
  PRIMARY KEY (run_id, skill_id, dimension)
);

CREATE TRIGGER algorithm_versions_no_update BEFORE UPDATE ON algorithm_versions BEGIN SELECT RAISE(ABORT, 'algorithm_versions is append-only'); END;
CREATE TRIGGER algorithm_versions_no_delete BEFORE DELETE ON algorithm_versions BEGIN SELECT RAISE(ABORT, 'algorithm_versions is append-only'); END;
CREATE TRIGGER analytics_runs_no_update BEFORE UPDATE ON analytics_runs BEGIN SELECT RAISE(ABORT, 'analytics_runs is append-only'); END;
CREATE TRIGGER analytics_runs_no_delete BEFORE DELETE ON analytics_runs BEGIN SELECT RAISE(ABORT, 'analytics_runs is append-only'); END;
CREATE TRIGGER mastery_snapshots_no_update BEFORE UPDATE ON mastery_snapshots BEGIN SELECT RAISE(ABORT, 'mastery_snapshots is append-only'); END;
CREATE TRIGGER mastery_snapshots_no_delete BEFORE DELETE ON mastery_snapshots BEGIN SELECT RAISE(ABORT, 'mastery_snapshots is append-only'); END;
