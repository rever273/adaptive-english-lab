-- Migration 004: content catalog history, review, release, reports (spec/03, spec/05, TASK_006, DECISION_LOG D33).
-- State is an append-only event log; "approved" can only be reached through a review whose hash equals the immutable
-- content hash. Enforcement is in triggers as a backstop to the application rules, so no code path (and no model
-- output) can promote a revision by writing a status. batches / exposures / reservations belong to later tasks.
-- Runs inside a runner-managed transaction. Do not edit after it has been applied: the runner checksums it.

CREATE TABLE exercise_skills (
  revision_id       TEXT NOT NULL REFERENCES exercise_revisions(id) ON DELETE RESTRICT,
  skill_revision_id TEXT NOT NULL REFERENCES skill_revisions(id) ON DELETE RESTRICT,
  role              TEXT NOT NULL CHECK (role IN ('target','additional')),
  PRIMARY KEY (revision_id, skill_revision_id)
);
-- exactly one target per revision (at-least-one is enforced by the registering transaction)
CREATE UNIQUE INDEX exercise_skills_one_target ON exercise_skills(revision_id) WHERE role = 'target';

CREATE TABLE prompt_units (
  id              TEXT PRIMARY KEY NOT NULL,
  canonical_text  TEXT NOT NULL,
  fingerprint     TEXT NOT NULL UNIQUE,
  normalizer_version TEXT NOT NULL,
  cluster_id      TEXT NOT NULL
);

CREATE TABLE revision_prompt_units (
  revision_id TEXT NOT NULL REFERENCES exercise_revisions(id) ON DELETE RESTRICT,
  unit_id     TEXT NOT NULL REFERENCES prompt_units(id) ON DELETE RESTRICT,
  role        TEXT NOT NULL CHECK (role IN ('prompt','option','answer','passage')),
  ordinal     INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (revision_id, unit_id, role)
);
CREATE INDEX revision_prompt_units_unit ON revision_prompt_units(unit_id);

CREATE TABLE content_state_events (
  id           TEXT PRIMARY KEY NOT NULL,
  revision_id  TEXT NOT NULL REFERENCES exercise_revisions(id) ON DELETE RESTRICT,
  sequence     INTEGER NOT NULL CHECK (sequence > 0),
  from_status  TEXT CHECK (from_status IS NULL OR from_status IN ('draft','validated','pending_review','approved','flagged','rejected')),
  to_status    TEXT NOT NULL CHECK (to_status IN ('draft','validated','pending_review','approved','flagged','rejected')),
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('code','model','agent','user')),
  actor_id     TEXT NOT NULL,
  reason       TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (revision_id, sequence)
);
CREATE INDEX content_state_events_latest ON content_state_events(revision_id, sequence DESC);

CREATE TABLE content_reviews (
  id             TEXT PRIMARY KEY NOT NULL,
  revision_id    TEXT NOT NULL REFERENCES exercise_revisions(id) ON DELETE RESTRICT,
  reviewer       TEXT NOT NULL CHECK (reviewer GLOB 'human:?*' OR reviewer GLOB 'agent:?*'),
  review_version TEXT NOT NULL CHECK (length(review_version) > 0),
  content_hash   TEXT NOT NULL,
  -- the revision's state sequence this review was written against: an approval needs a review of the state it leaves
  at_sequence    INTEGER NOT NULL CHECK (at_sequence > 0),
  checklist_json TEXT NOT NULL CHECK (json_valid(checklist_json)),
  verdict        TEXT NOT NULL CHECK (verdict IN ('approved','flagged','rejected')),
  created_at     TEXT NOT NULL
);
CREATE INDEX content_reviews_revision ON content_reviews(revision_id, verdict);

CREATE TABLE releases (
  id            TEXT PRIMARY KEY NOT NULL,
  manifest_hash TEXT NOT NULL UNIQUE,
  reviewer      TEXT NOT NULL CHECK (reviewer GLOB 'human:?*' OR reviewer GLOB 'agent:?*'),
  created_at    TEXT NOT NULL
);

CREATE TABLE release_items (
  release_id  TEXT NOT NULL REFERENCES releases(id) ON DELETE RESTRICT,
  revision_id TEXT NOT NULL REFERENCES exercise_revisions(id) ON DELETE RESTRICT,
  review_id   TEXT NOT NULL REFERENCES content_reviews(id) ON DELETE RESTRICT,
  PRIMARY KEY (release_id, revision_id)
);

CREATE TABLE exercise_reports (
  id                    TEXT PRIMARY KEY NOT NULL,
  revision_id           TEXT NOT NULL REFERENCES exercise_revisions(id) ON DELETE RESTRICT,
  session_id            TEXT REFERENCES sessions(id) ON DELETE RESTRICT,
  reason                TEXT NOT NULL CHECK (length(reason) > 0),
  created_at            TEXT NOT NULL,
  resolved_by_review_id TEXT REFERENCES content_reviews(id) ON DELETE RESTRICT
);

-- ---------- projections ----------

CREATE VIEW latest_content_state AS
SELECT revision_id, to_status AS status, sequence, content_hash, actor_type, actor_id, created_at
FROM (
  SELECT e.*, row_number() OVER (PARTITION BY e.revision_id ORDER BY e.sequence DESC) AS rn
  FROM content_state_events e
) WHERE rn = 1;

-- Only approved + released revisions can ever be shown. draft / validated / pending_review / flagged / rejected never are.
CREATE VIEW selectable_revisions AS
SELECT er.id AS revision_id, er.exercise_id, er.type, er.dimension, er.difficulty, er.bank_role, er.content_hash
FROM exercise_revisions er
JOIN latest_content_state s ON s.revision_id = er.id AND s.status = 'approved'
WHERE EXISTS (
  SELECT 1 FROM release_items ri JOIN content_reviews cr ON cr.id = ri.review_id
   WHERE ri.revision_id = er.id AND cr.verdict = 'approved' AND cr.content_hash = er.content_hash
);

-- ---------- integrity triggers ----------

-- state events always carry the immutable content hash of their revision
CREATE TRIGGER content_state_events_hash BEFORE INSERT ON content_state_events
WHEN NEW.content_hash <> (SELECT content_hash FROM exercise_revisions WHERE id = NEW.revision_id)
BEGIN
  SELECT RAISE(ABORT, 'content_state_events: content_hash must equal the revision content hash');
END;

-- sequence chain: 1,2,3...; first event is draft with no predecessor; from_status = previous to_status
CREATE TRIGGER content_state_events_chain BEFORE INSERT ON content_state_events
WHEN NEW.sequence <> COALESCE((SELECT MAX(sequence) FROM content_state_events WHERE revision_id = NEW.revision_id), 0) + 1
  OR NEW.from_status IS NOT (SELECT to_status FROM content_state_events WHERE revision_id = NEW.revision_id AND sequence = NEW.sequence - 1)
  OR (NEW.sequence = 1 AND NEW.to_status <> 'draft')
BEGIN
  SELECT RAISE(ABORT, 'content_state_events: invalid sequence / from_status chain (the first state must be draft)');
END;

-- the state machine (spec/05): rejected is terminal; approved is reached only from pending_review or flagged
CREATE TRIGGER content_state_events_transition BEFORE INSERT ON content_state_events
WHEN NEW.from_status IS NOT NULL
  AND (NEW.from_status, NEW.to_status) NOT IN (VALUES
    ('draft','validated'), ('validated','pending_review'), ('pending_review','approved'), ('flagged','approved'),
    ('draft','flagged'), ('validated','flagged'), ('pending_review','flagged'), ('approved','flagged'),
    ('draft','rejected'), ('validated','rejected'), ('pending_review','rejected'), ('flagged','rejected'))
BEGIN
  SELECT RAISE(ABORT, 'content_state_events: transition not allowed');
END;

-- authority: a model may only create the draft; only code validates; approval needs a human/agent reviewer
CREATE TRIGGER content_state_events_actor BEFORE INSERT ON content_state_events
WHEN (NEW.actor_type = 'model' AND NEW.to_status <> 'draft')
  OR (NEW.to_status = 'validated' AND NEW.actor_type <> 'code')
  OR (NEW.to_status = 'approved' AND NEW.actor_type NOT IN ('user','agent'))
  OR (NEW.to_status = 'rejected' AND NEW.actor_type NOT IN ('user','agent'))
BEGIN
  SELECT RAISE(ABORT, 'content_state_events: actor is not authorised for this transition');
END;

-- approval needs an approved review of the same hash that was written against the state being left (a re-approval
-- after a flag therefore needs a fresh review record, not the old one)
CREATE TRIGGER content_state_events_approval BEFORE INSERT ON content_state_events
WHEN NEW.to_status = 'approved'
  AND NOT EXISTS (
    SELECT 1 FROM content_reviews r
     WHERE r.revision_id = NEW.revision_id AND r.verdict = 'approved' AND r.content_hash = NEW.content_hash
       AND r.at_sequence = (SELECT MAX(e.sequence) FROM content_state_events e WHERE e.revision_id = NEW.revision_id)
  )
BEGIN
  SELECT RAISE(ABORT, 'content_state_events: approval requires a newer approved review with the same content hash');
END;

-- a review is written against the current state, and only while the revision is awaiting a decision
CREATE TRIGGER content_reviews_state BEFORE INSERT ON content_reviews
WHEN NEW.at_sequence IS NOT (SELECT MAX(sequence) FROM content_state_events WHERE revision_id = NEW.revision_id)
  OR (SELECT to_status FROM content_state_events WHERE revision_id = NEW.revision_id AND sequence = NEW.at_sequence) NOT IN ('pending_review','flagged')
BEGIN
  SELECT RAISE(ABORT, 'content_reviews: a review must be written against the current pending_review/flagged state');
END;

-- a review always names the hash it actually read
CREATE TRIGGER content_reviews_hash BEFORE INSERT ON content_reviews
WHEN NEW.content_hash <> (SELECT content_hash FROM exercise_revisions WHERE id = NEW.revision_id)
BEGIN
  SELECT RAISE(ABORT, 'content_reviews: content_hash must equal the revision content hash');
END;

-- a release item must be approved now, with its own approved review of the same hash
CREATE TRIGGER release_items_guard BEFORE INSERT ON release_items
WHEN (SELECT status FROM latest_content_state WHERE revision_id = NEW.revision_id) IS NOT 'approved'
  OR NOT EXISTS (
    SELECT 1 FROM content_reviews r JOIN exercise_revisions er ON er.id = r.revision_id
     WHERE r.id = NEW.review_id AND r.revision_id = NEW.revision_id AND r.verdict = 'approved' AND r.content_hash = er.content_hash
  )
BEGIN
  SELECT RAISE(ABORT, 'release_items: revision must be approved with a matching approved review');
END;

-- reports: only resolved_by_review_id may be set, once
CREATE TRIGGER exercise_reports_update BEFORE UPDATE ON exercise_reports
WHEN OLD.resolved_by_review_id IS NOT NULL
  OR NEW.resolved_by_review_id IS NULL
  OR NEW.id <> OLD.id OR NEW.revision_id <> OLD.revision_id OR NEW.reason <> OLD.reason OR NEW.created_at <> OLD.created_at
  OR NEW.session_id IS NOT OLD.session_id
BEGIN
  SELECT RAISE(ABORT, 'exercise_reports: only resolved_by_review_id may be set, once');
END;
CREATE TRIGGER exercise_reports_no_delete BEFORE DELETE ON exercise_reports BEGIN SELECT RAISE(ABORT, 'exercise_reports is append-only'); END;

CREATE TRIGGER content_state_events_no_update BEFORE UPDATE ON content_state_events BEGIN SELECT RAISE(ABORT, 'content_state_events is append-only'); END;
CREATE TRIGGER content_state_events_no_delete BEFORE DELETE ON content_state_events BEGIN SELECT RAISE(ABORT, 'content_state_events is append-only'); END;
CREATE TRIGGER content_reviews_no_update BEFORE UPDATE ON content_reviews BEGIN SELECT RAISE(ABORT, 'content_reviews is append-only'); END;
CREATE TRIGGER content_reviews_no_delete BEFORE DELETE ON content_reviews BEGIN SELECT RAISE(ABORT, 'content_reviews is append-only'); END;
CREATE TRIGGER releases_no_update BEFORE UPDATE ON releases BEGIN SELECT RAISE(ABORT, 'releases is append-only'); END;
CREATE TRIGGER releases_no_delete BEFORE DELETE ON releases BEGIN SELECT RAISE(ABORT, 'releases is append-only'); END;
CREATE TRIGGER release_items_no_update BEFORE UPDATE ON release_items BEGIN SELECT RAISE(ABORT, 'release_items is append-only'); END;
CREATE TRIGGER release_items_no_delete BEFORE DELETE ON release_items BEGIN SELECT RAISE(ABORT, 'release_items is append-only'); END;
CREATE TRIGGER exercise_skills_no_update BEFORE UPDATE ON exercise_skills BEGIN SELECT RAISE(ABORT, 'exercise_skills is append-only'); END;
CREATE TRIGGER exercise_skills_no_delete BEFORE DELETE ON exercise_skills BEGIN SELECT RAISE(ABORT, 'exercise_skills is append-only'); END;
CREATE TRIGGER prompt_units_no_update BEFORE UPDATE ON prompt_units BEGIN SELECT RAISE(ABORT, 'prompt_units is append-only'); END;
CREATE TRIGGER prompt_units_no_delete BEFORE DELETE ON prompt_units BEGIN SELECT RAISE(ABORT, 'prompt_units is append-only'); END;
CREATE TRIGGER revision_prompt_units_no_update BEFORE UPDATE ON revision_prompt_units BEGIN SELECT RAISE(ABORT, 'revision_prompt_units is append-only'); END;
CREATE TRIGGER revision_prompt_units_no_delete BEFORE DELETE ON revision_prompt_units BEGIN SELECT RAISE(ABORT, 'revision_prompt_units is append-only'); END;
