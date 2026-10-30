-- Migration 008: generation batches (spec/03, spec/05, spec/06, TASK_010, DECISION_LOG D46).
-- A batch is a request for N draft exercises; each ordinal is one batch_item that ends as a stored draft revision or as a quarantined
-- failure. Items only record how generation went: approval, release and the statuses after "generated" are DERIVED from the immutable
-- content state/review/release events (migration 004), never copied here, so batch totals can always be reconstructed.
-- Runs inside a runner-managed transaction. Do not edit after it has been applied: the runner checksums it.

CREATE TABLE batches (
  id                TEXT PRIMARY KEY NOT NULL,
  requested_count   INTEGER NOT NULL CHECK (requested_count BETWEEN 1 AND 500),
  mode              TEXT NOT NULL CHECK (mode IN ('adaptive','balanced','manual')),
  purpose           TEXT NOT NULL CHECK (purpose IN ('trial','scale')),
  prompt_version_id TEXT NOT NULL REFERENCES prompt_versions(id) ON DELETE RESTRICT,
  spec_json         TEXT NOT NULL CHECK (json_valid(spec_json)),
  created_at        TEXT NOT NULL,
  CHECK (purpose <> 'trial' OR requested_count = 24)
);

CREATE TABLE batch_items (
  id          TEXT PRIMARY KEY NOT NULL,
  batch_id    TEXT NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  ordinal     INTEGER NOT NULL CHECK (ordinal >= 0),
  plan_json   TEXT NOT NULL CHECK (json_valid(plan_json)),
  revision_id TEXT REFERENCES exercise_revisions(id) ON DELETE RESTRICT,
  job_id      TEXT REFERENCES jobs(id) ON DELETE RESTRICT,
  -- the generator writes queued -> generated | invalid; ready_for_review / released / rejected are reported from the content events
  state       TEXT NOT NULL CHECK (state IN ('queued','generated','invalid','ready_for_review','released','rejected')),
  error_json  TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  updated_at  TEXT NOT NULL,
  UNIQUE (batch_id, ordinal),
  CHECK (state <> 'generated' OR revision_id IS NOT NULL),
  CHECK (state <> 'invalid' OR error_json IS NOT NULL)
);
CREATE UNIQUE INDEX batch_items_revision ON batch_items(revision_id) WHERE revision_id IS NOT NULL;
CREATE INDEX batch_items_batch ON batch_items(batch_id, state);

ALTER TABLE exercises ADD COLUMN source_batch_id TEXT REFERENCES batches(id) ON DELETE RESTRICT;
ALTER TABLE jobs ADD COLUMN batch_id TEXT REFERENCES batches(id) ON DELETE RESTRICT;

-- batches are immutable requests
CREATE TRIGGER batches_no_update BEFORE UPDATE ON batches BEGIN SELECT RAISE(ABORT, 'batches is append-only'); END;
CREATE TRIGGER batches_no_delete BEFORE DELETE ON batches BEGIN SELECT RAISE(ABORT, 'batches is append-only'); END;
CREATE TRIGGER batch_items_no_delete BEFORE DELETE ON batch_items BEGIN SELECT RAISE(ABORT, 'batch_items is append-only'); END;

-- an item may be assigned to a job while queued, and settle exactly once; nothing else about it changes
CREATE TRIGGER batch_items_update BEFORE UPDATE ON batch_items
WHEN NEW.id <> OLD.id OR NEW.batch_id <> OLD.batch_id OR NEW.ordinal <> OLD.ordinal OR NEW.plan_json <> OLD.plan_json
  OR OLD.state <> 'queued'
  OR NEW.state NOT IN ('queued','generated','invalid')
BEGIN
  SELECT RAISE(ABORT, 'batch_items: an item settles once (queued -> generated | invalid); its plan never changes');
END;

-- a generated item must point at a revision that came from the same batch's model draft, never at an approved/selectable one
CREATE TRIGGER batch_items_generated_is_draft_origin BEFORE UPDATE ON batch_items
WHEN NEW.state = 'generated'
  AND (SELECT MIN(sequence) FROM content_state_events WHERE revision_id = NEW.revision_id) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'batch_items: a generated item needs a stored draft revision');
END;
