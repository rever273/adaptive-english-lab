-- Migration 006: persistent job queue, GPU lock and measured profiles (spec/03, spec/07, TASK_008, DECISION_LOG D41).
-- The queue is server-owned and durable: closing the browser never touches it. jobs.prompt_version_id and jobs.batch_id are added by the
-- migrations that create their parent tables (ALTER TABLE ... ADD COLUMN ... REFERENCES). History is append-only (job_events, job_results).
-- Runs inside a runner-managed transaction. Do not edit after it has been applied: the runner checksums it.

CREATE TABLE jobs (
  id               TEXT PRIMARY KEY NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('free_text_analysis','triage','generation','vocabulary_enrichment','tutor','benchmark','diagnostic_probe','test_unit')),
  state            TEXT NOT NULL CHECK (state IN ('queued','waiting_for_gpu','running','paused','completed','failed','cancelled')),
  -- 1 = post-session assessment, 2 = foreground tutor/vocabulary, 3 = generation (P0 is the STT grant, not a job)
  priority         INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 3),
  payload_json     TEXT NOT NULL CHECK (json_valid(payload_json)),
  model_version_id TEXT REFERENCES model_versions(id) ON DELETE RESTRICT,
  idempotency_key  TEXT NOT NULL UNIQUE,
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT,
  retry_count      INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  available_at     TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  checkpoint_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(checkpoint_json)),
  lease_token      INTEGER,
  heartbeat_at     TEXT,
  error_code       TEXT
);
CREATE INDEX jobs_pick ON jobs(state, priority, available_at, created_at);

CREATE TABLE job_events (
  id         TEXT PRIMARY KEY NOT NULL,
  job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  sequence   INTEGER NOT NULL CHECK (sequence > 0),
  state      TEXT NOT NULL CHECK (state IN ('queued','waiting_for_gpu','running','paused','completed','failed','cancelled')),
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (job_id, sequence)
);

CREATE TABLE job_results (
  id             TEXT PRIMARY KEY NOT NULL,
  job_id         TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE RESTRICT,
  schema_version TEXT NOT NULL,
  output_json    TEXT NOT NULL CHECK (json_valid(output_json)),
  output_hash    TEXT NOT NULL,
  metrics_json   TEXT NOT NULL CHECK (json_valid(metrics_json)),
  created_at     TEXT NOT NULL
);

-- exactly one row: the GPU lease with its fencing token (spec/07)
CREATE TABLE gpu_lock (
  id            INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  owner_id      TEXT,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
  lease_until   TEXT
);
INSERT INTO gpu_lock(id, owner_id, fencing_token, lease_until) VALUES (1, NULL, 0, NULL);

CREATE TABLE gpu_profiles (
  id                TEXT PRIMARY KEY NOT NULL,
  model_version_id  TEXT NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  config_hash       TEXT NOT NULL,
  measured_peak_mib INTEGER NOT NULL CHECK (measured_peak_mib > 0),
  timings_json      TEXT NOT NULL CHECK (json_valid(timings_json)),
  validated_at      TEXT NOT NULL,
  UNIQUE (model_version_id, config_hash)
);

-- the job state machine (spec/07): illegal transitions are refused by the database, not only by the scheduler
CREATE TRIGGER jobs_state_machine BEFORE UPDATE OF state ON jobs
WHEN OLD.state <> NEW.state AND (OLD.state, NEW.state) NOT IN (VALUES
  ('queued','waiting_for_gpu'), ('queued','running'), ('queued','cancelled'), ('queued','paused'),
  ('waiting_for_gpu','queued'), ('waiting_for_gpu','running'), ('waiting_for_gpu','cancelled'), ('waiting_for_gpu','paused'),
  ('running','completed'), ('running','paused'), ('running','cancelled'), ('running','queued'), ('running','failed'),
  ('paused','queued'), ('paused','cancelled'),
  ('failed','queued'))
BEGIN
  SELECT RAISE(ABORT, 'jobs: illegal state transition');
END;

-- terminal states stay terminal except an explicit retry of a failed job
CREATE TRIGGER jobs_terminal BEFORE UPDATE OF state ON jobs
WHEN OLD.state IN ('completed','cancelled')
BEGIN
  SELECT RAISE(ABORT, 'jobs: terminal state');
END;

CREATE TRIGGER jobs_no_delete BEFORE DELETE ON jobs BEGIN SELECT RAISE(ABORT, 'jobs are never deleted'); END;
CREATE TRIGGER job_events_no_update BEFORE UPDATE ON job_events BEGIN SELECT RAISE(ABORT, 'job_events is append-only'); END;
CREATE TRIGGER job_events_no_delete BEFORE DELETE ON job_events BEGIN SELECT RAISE(ABORT, 'job_events is append-only'); END;
CREATE TRIGGER job_results_no_update BEFORE UPDATE ON job_results BEGIN SELECT RAISE(ABORT, 'job_results is append-only'); END;
CREATE TRIGGER job_results_no_delete BEFORE DELETE ON job_results BEGIN SELECT RAISE(ABORT, 'job_results is append-only'); END;
CREATE TRIGGER gpu_profiles_no_delete BEFORE DELETE ON gpu_profiles BEGIN SELECT RAISE(ABORT, 'gpu_profiles is append-only'); END;
-- a job can be neither completed twice nor have its result replaced
CREATE TRIGGER jobs_fencing_monotonic BEFORE UPDATE OF lease_token ON jobs
WHEN NEW.lease_token IS NOT NULL AND OLD.lease_token IS NOT NULL AND NEW.lease_token < OLD.lease_token
BEGIN
  SELECT RAISE(ABORT, 'jobs: fencing token can only grow');
END;
