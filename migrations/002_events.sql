-- Migration 002: raw practice events, attempts, assessment revisions, evidence (spec/03, TASK_004, DECISION_LOG D26).
-- Contains the event tables plus the minimal parents their foreign keys need (exercises, exercise_revisions,
-- model_versions, blueprints, blueprint_revisions), exactly as in spec/03. Columns that point at tables created by later
-- tasks (exercises.source_batch_id -> batches, assessment_revisions.ai_annotation_id -> ai_annotations) are added then
-- with ALTER TABLE ... ADD COLUMN ... REFERENCES. History tables are append-only (triggers at the end).
-- Runs inside a runner-managed transaction. Do not edit after it has been applied: the runner checksums it.

-- ---------- minimal parents ----------

CREATE TABLE exercises (
  id         TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE exercise_revisions (
  id              TEXT PRIMARY KEY NOT NULL,
  exercise_id     TEXT NOT NULL REFERENCES exercises(id) ON DELETE RESTRICT,
  revision        INTEGER NOT NULL CHECK (revision > 0),
  schema_version  TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('choose_form','choose_missing_fragment','detect_error','guided_short_answer','russian_to_english_short','context_reading')),
  content_json    TEXT NOT NULL CHECK (json_valid(content_json)),
  content_hash    TEXT NOT NULL UNIQUE,
  rubric_version  TEXT NOT NULL,
  taxonomy_id     TEXT NOT NULL REFERENCES taxonomy_versions(id) ON DELETE RESTRICT,
  dimension       TEXT NOT NULL CHECK (dimension IN ('recognition','correction','production')),
  difficulty      TEXT NOT NULL CHECK (difficulty IN ('A2','B1','B2','C1')),
  topic           TEXT NOT NULL,
  context_id      TEXT NOT NULL,
  template_cluster TEXT NOT NULL,
  bank_role       TEXT NOT NULL CHECK (bank_role IN ('practice','diagnostic','heldout')),
  created_at      TEXT NOT NULL,
  UNIQUE (exercise_id, revision)
);

CREATE TABLE model_versions (
  id              TEXT PRIMARY KEY NOT NULL,
  tag             TEXT NOT NULL,
  digest          TEXT NOT NULL,
  runtime         TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json)),
  UNIQUE (tag, digest, runtime_version)
);

CREATE TABLE blueprints (
  id         TEXT PRIMARY KEY NOT NULL,
  stable_key TEXT NOT NULL UNIQUE
);

CREATE TABLE blueprint_revisions (
  id           TEXT PRIMARY KEY NOT NULL,
  blueprint_id TEXT NOT NULL REFERENCES blueprints(id) ON DELETE RESTRICT,
  revision     INTEGER NOT NULL CHECK (revision > 0),
  policy_json  TEXT NOT NULL CHECK (json_valid(policy_json)),
  status       TEXT NOT NULL CHECK (status IN ('draft','pending_review','approved','published','retired')),
  reviewer     TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (blueprint_id, revision)
);

-- ---------- sessions, slots, events ----------

CREATE TABLE sessions (
  id                    TEXT PRIMARY KEY NOT NULL,
  blueprint_revision_id TEXT REFERENCES blueprint_revisions(id) ON DELETE RESTRICT,
  purpose               TEXT NOT NULL CHECK (purpose IN ('practice','diagnostic','heldout')),
  settings_revision_id  TEXT NOT NULL REFERENCES settings_revisions(id) ON DELETE RESTRICT,
  plan_id               TEXT NOT NULL REFERENCES learning_plans(id) ON DELETE RESTRICT,
  selection_version     TEXT NOT NULL,
  random_seed           TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('active','suspended','completed','ended_early')),
  created_at            TEXT NOT NULL,
  ended_at              TEXT,
  timezone              TEXT NOT NULL
);

CREATE TABLE session_slots (
  id                   TEXT PRIMARY KEY NOT NULL,
  session_id           TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  ordinal              INTEGER NOT NULL CHECK (ordinal >= 0),
  exercise_revision_id TEXT NOT NULL REFERENCES exercise_revisions(id) ON DELETE RESTRICT,
  question_id          TEXT,
  reading_group_id     TEXT,
  input_preference     TEXT NOT NULL CHECK (input_preference IN ('text','voice')),
  cohort_json          TEXT NOT NULL CHECK (json_valid(cohort_json)),
  UNIQUE (session_id, ordinal)
);

CREATE TABLE session_events (
  id              TEXT PRIMARY KEY NOT NULL,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  slot_id         TEXT REFERENCES session_slots(id) ON DELETE RESTRICT,
  client_event_id TEXT NOT NULL UNIQUE,
  event_type      TEXT NOT NULL CHECK (event_type IN ('reveal','hint','show_answer','skip','continue','resume','finish','replacement')),
  payload_json    TEXT NOT NULL CHECK (json_valid(payload_json)),
  server_at       TEXT NOT NULL,
  local_date      TEXT NOT NULL,
  timezone        TEXT NOT NULL
);
CREATE INDEX session_events_slot ON session_events(slot_id, event_type, server_at);

-- ---------- transcripts and attempts ----------

CREATE TABLE transcripts (
  id             TEXT PRIMARY KEY NOT NULL,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  slot_id        TEXT NOT NULL REFERENCES session_slots(id) ON DELETE RESTRICT,
  asr_text       TEXT NOT NULL,
  submitted_text TEXT,
  edited         INTEGER NOT NULL CHECK (edited IN (0, 1)),
  stt_model_id   TEXT NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  created_at     TEXT NOT NULL
);

CREATE TABLE attempts (
  id                 TEXT PRIMARY KEY NOT NULL,
  slot_id            TEXT NOT NULL REFERENCES session_slots(id) ON DELETE RESTRICT,
  submission_id      TEXT NOT NULL UNIQUE,
  attempt_no         INTEGER NOT NULL CHECK (attempt_no > 0),
  first_attempt      INTEGER NOT NULL CHECK (first_attempt IN (0, 1)),
  raw_answer_json    TEXT NOT NULL CHECK (json_valid(raw_answer_json)),
  input_mode         TEXT NOT NULL CHECK (input_mode IN ('text','voice')),
  transcript_id      TEXT REFERENCES transcripts(id) ON DELETE RESTRICT,
  hints_before       INTEGER NOT NULL CHECK (hints_before >= 0),
  answer_seen_before INTEGER NOT NULL CHECK (answer_seen_before IN (0, 1)),
  idk                INTEGER NOT NULL CHECK (idk IN (0, 1)),
  submitted_at       TEXT NOT NULL,
  local_date         TEXT NOT NULL,
  timezone           TEXT NOT NULL,
  latency_ms         INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  criterion_version  TEXT NOT NULL,
  UNIQUE (slot_id, attempt_no),
  CHECK ((first_attempt = 1) = (attempt_no = 1))
);
-- First attempt is decided by the server from the ordinal; at most one per slot.
CREATE UNIQUE INDEX attempts_one_first_per_slot ON attempts(slot_id) WHERE first_attempt = 1;
CREATE INDEX attempts_submitted ON attempts(submitted_at, slot_id);

-- ---------- assessments, evidence, findings ----------

CREATE TABLE assessment_revisions (
  id               TEXT PRIMARY KEY NOT NULL,
  attempt_id       TEXT NOT NULL REFERENCES attempts(id) ON DELETE RESTRICT,
  sequence         INTEGER NOT NULL CHECK (sequence > 0),
  source           TEXT NOT NULL CHECK (source IN ('deterministic','model','human')),
  verdict          TEXT NOT NULL CHECK (verdict IN ('correct','incorrect','idk','pending','ambiguous','disputed','rejected')),
  confirmation     TEXT NOT NULL CHECK (confirmation IN ('confirmed','tentative','uncertain','disputed','rejected')),
  criterion_version TEXT NOT NULL,
  model_version_id TEXT REFERENCES model_versions(id) ON DELETE RESTRICT,
  supersedes_id    TEXT REFERENCES assessment_revisions(id) ON DELETE RESTRICT,
  rationale        TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE (attempt_id, sequence),
  -- model output can never be confirmed on its own authority (spec/03)
  CHECK (source <> 'model' OR confirmation <> 'confirmed')
);
CREATE INDEX assessment_revisions_latest ON assessment_revisions(attempt_id, sequence DESC);

CREATE TABLE skill_opportunities (
  id               TEXT PRIMARY KEY NOT NULL,
  assessment_id    TEXT NOT NULL REFERENCES assessment_revisions(id) ON DELETE RESTRICT,
  skill_revision_id TEXT NOT NULL REFERENCES skill_revisions(id) ON DELETE RESTRICT,
  dimension        TEXT NOT NULL CHECK (dimension IN ('recognition','correction','production')),
  target           INTEGER NOT NULL CHECK (target IN (0, 1)),
  opportunity_type TEXT NOT NULL CHECK (opportunity_type IN ('explicit','observed')),
  reliability      TEXT NOT NULL CHECK (reliability IN ('confirmed','tentative','uncertain')),
  result           TEXT NOT NULL CHECK (result IN ('success','failure','idk','unknown')),
  independent      INTEGER NOT NULL CHECK (independent IN (0, 1)),
  evidence_group   TEXT NOT NULL,
  UNIQUE (assessment_id, skill_revision_id, dimension, evidence_group)
);
CREATE INDEX skill_opportunities_skill ON skill_opportunities(skill_revision_id, dimension, assessment_id);

CREATE TABLE error_events (
  id               TEXT PRIMARY KEY NOT NULL,
  assessment_id    TEXT NOT NULL REFERENCES assessment_revisions(id) ON DELETE RESTRICT,
  skill_revision_id TEXT NOT NULL REFERENCES skill_revisions(id) ON DELETE RESTRICT,
  fragment_start   INTEGER CHECK (fragment_start IS NULL OR fragment_start >= 0),
  fragment_end     INTEGER,
  correction       TEXT,
  explanation_ru   TEXT NOT NULL,
  finding_type     TEXT NOT NULL CHECK (finding_type IN ('grammar','style','ambiguity')),
  verdict          TEXT NOT NULL CHECK (verdict IN ('confirmed','tentative','uncertain','disputed','rejected')),
  confidence       REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  model_version_id TEXT REFERENCES model_versions(id) ON DELETE RESTRICT,
  created_at       TEXT NOT NULL,
  CHECK ((fragment_start IS NULL) = (fragment_end IS NULL)),
  CHECK (fragment_end IS NULL OR fragment_end > fragment_start)
);
CREATE INDEX error_events_skill ON error_events(skill_revision_id, verdict, assessment_id);

CREATE TABLE finding_review_events (
  id             TEXT PRIMARY KEY NOT NULL,
  finding_id     TEXT NOT NULL REFERENCES error_events(id) ON DELETE RESTRICT,
  sequence       INTEGER NOT NULL CHECK (sequence > 0),
  verdict        TEXT NOT NULL CHECK (verdict IN ('confirmed','tentative','uncertain','disputed','rejected')),
  reviewer       TEXT NOT NULL,
  review_version TEXT NOT NULL,
  source_hash    TEXT NOT NULL,
  reason         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE (finding_id, sequence)
);
CREATE INDEX finding_review_events_latest ON finding_review_events(finding_id, sequence DESC);

CREATE TABLE assessment_disputes (
  id                       TEXT PRIMARY KEY NOT NULL,
  assessment_id            TEXT NOT NULL REFERENCES assessment_revisions(id) ON DELETE RESTRICT,
  reason                   TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  resolution_assessment_id TEXT REFERENCES assessment_revisions(id) ON DELETE RESTRICT
);

-- ---------- projections (spec/09): derived, never the source of truth ----------

CREATE VIEW latest_assessments AS
SELECT * FROM (
  SELECT a.*, row_number() OVER (PARTITION BY a.attempt_id ORDER BY a.sequence DESC) AS rn
  FROM assessment_revisions a
) WHERE rn = 1;

CREATE VIEW confirmed_opportunities AS
SELECT o.*, a.attempt_id, t.submitted_at, t.local_date, t.input_mode,
       ss.exercise_revision_id, s.purpose, s.id AS session_id
FROM skill_opportunities o
JOIN latest_assessments a ON a.id = o.assessment_id
JOIN attempts t ON t.id = a.attempt_id
JOIN session_slots ss ON ss.id = t.slot_id
JOIN sessions s ON s.id = ss.session_id
WHERE a.confirmation = 'confirmed' AND a.verdict IN ('correct','incorrect','idk')
  AND o.reliability = 'confirmed' AND o.target = 1 AND o.independent = 1
  AND o.opportunity_type = 'explicit' AND o.result IN ('success','failure','idk')
  AND t.first_attempt = 1 AND t.hints_before = 0 AND t.answer_seen_before = 0;

-- ---------- integrity triggers ----------

-- Attempts of one slot are numbered 1,2,3... without gaps.
CREATE TRIGGER attempts_sequence BEFORE INSERT ON attempts
WHEN NEW.attempt_no <> COALESCE((SELECT MAX(attempt_no) FROM attempts WHERE slot_id = NEW.slot_id), 0) + 1
BEGIN
  SELECT RAISE(ABORT, 'attempts: attempt_no must be previous + 1');
END;

-- Assessment revisions form one chain per attempt: no branching, no gaps, supersedes = previous.
CREATE TRIGGER assessment_revisions_chain BEFORE INSERT ON assessment_revisions
WHEN NEW.sequence <> COALESCE((SELECT MAX(sequence) FROM assessment_revisions WHERE attempt_id = NEW.attempt_id), 0) + 1
  OR NEW.supersedes_id IS NOT (SELECT id FROM assessment_revisions WHERE attempt_id = NEW.attempt_id AND sequence = NEW.sequence - 1)
BEGIN
  SELECT RAISE(ABORT, 'assessment_revisions: sequence must be latest + 1 and supersedes_id the previous revision');
END;

CREATE TRIGGER finding_review_events_chain BEFORE INSERT ON finding_review_events
WHEN NEW.sequence <> COALESCE((SELECT MAX(sequence) FROM finding_review_events WHERE finding_id = NEW.finding_id), 0) + 1
BEGIN
  SELECT RAISE(ABORT, 'finding_review_events: sequence must be latest + 1');
END;

-- Append-only history (spec/03). Corrections are new rows; nothing here is updated or deleted.
CREATE TRIGGER attempts_no_update BEFORE UPDATE ON attempts BEGIN SELECT RAISE(ABORT, 'attempts is append-only'); END;
CREATE TRIGGER attempts_no_delete BEFORE DELETE ON attempts BEGIN SELECT RAISE(ABORT, 'attempts is append-only'); END;
CREATE TRIGGER session_events_no_update BEFORE UPDATE ON session_events BEGIN SELECT RAISE(ABORT, 'session_events is append-only'); END;
CREATE TRIGGER session_events_no_delete BEFORE DELETE ON session_events BEGIN SELECT RAISE(ABORT, 'session_events is append-only'); END;
CREATE TRIGGER exercise_revisions_no_update BEFORE UPDATE ON exercise_revisions BEGIN SELECT RAISE(ABORT, 'exercise_revisions is immutable; create a new revision'); END;
CREATE TRIGGER exercise_revisions_no_delete BEFORE DELETE ON exercise_revisions BEGIN SELECT RAISE(ABORT, 'exercise_revisions is immutable; create a new revision'); END;
CREATE TRIGGER assessment_revisions_no_update BEFORE UPDATE ON assessment_revisions BEGIN SELECT RAISE(ABORT, 'assessment_revisions is append-only'); END;
CREATE TRIGGER assessment_revisions_no_delete BEFORE DELETE ON assessment_revisions BEGIN SELECT RAISE(ABORT, 'assessment_revisions is append-only'); END;
CREATE TRIGGER error_events_no_update BEFORE UPDATE ON error_events BEGIN SELECT RAISE(ABORT, 'error_events is append-only'); END;
CREATE TRIGGER error_events_no_delete BEFORE DELETE ON error_events BEGIN SELECT RAISE(ABORT, 'error_events is append-only'); END;
CREATE TRIGGER finding_review_events_no_update BEFORE UPDATE ON finding_review_events BEGIN SELECT RAISE(ABORT, 'finding_review_events is append-only'); END;
CREATE TRIGGER finding_review_events_no_delete BEFORE DELETE ON finding_review_events BEGIN SELECT RAISE(ABORT, 'finding_review_events is append-only'); END;
CREATE TRIGGER skill_opportunities_no_update BEFORE UPDATE ON skill_opportunities BEGIN SELECT RAISE(ABORT, 'skill_opportunities is append-only'); END;
CREATE TRIGGER skill_opportunities_no_delete BEFORE DELETE ON skill_opportunities BEGIN SELECT RAISE(ABORT, 'skill_opportunities is append-only'); END;
