-- Migration 005: reservations, exposures, practice leases, scheduling decisions (spec/03, TASK_007, DECISION_LOG D35).
-- "Reserved" and "shown" are different facts: a reservation holds a sentence unit for one session snapshot; an exposure is
-- written BEFORE the learner can see the unit and makes it seen forever (even if the slot is skipped).
-- Runs inside a runner-managed transaction. Do not edit after it has been applied: the runner checksums it.

CREATE TABLE prompt_reservations (
  unit_id    TEXT PRIMARY KEY NOT NULL REFERENCES prompt_units(id) ON DELETE RESTRICT,
  slot_id    TEXT NOT NULL REFERENCES session_slots(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX prompt_reservations_slot ON prompt_reservations(slot_id);

CREATE TABLE exposures (
  id         TEXT PRIMARY KEY NOT NULL,
  unit_id    TEXT NOT NULL UNIQUE REFERENCES prompt_units(id) ON DELETE RESTRICT,
  slot_id    TEXT NOT NULL REFERENCES session_slots(id) ON DELETE RESTRICT,
  exposed_at TEXT NOT NULL
);

CREATE TABLE practice_leases (
  session_id   TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  tab_id       TEXT NOT NULL,
  token        INTEGER NOT NULL CHECK (token > 0),
  heartbeat_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

CREATE TABLE scheduling_decisions (
  id             TEXT PRIMARY KEY NOT NULL,
  session_id     TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE RESTRICT,
  algorithm_id   TEXT NOT NULL REFERENCES algorithm_versions(id) ON DELETE RESTRICT,
  candidate_hash TEXT NOT NULL,
  choices_json   TEXT NOT NULL CHECK (json_valid(choices_json)),
  deficits_json  TEXT NOT NULL CHECK (json_valid(deficits_json)),
  created_at     TEXT NOT NULL
);

-- A unit that has been shown can never be reserved again (no-repeat is enforced by the database, not only the allocator).
CREATE TRIGGER prompt_reservations_not_exposed BEFORE INSERT ON prompt_reservations
WHEN EXISTS (SELECT 1 FROM exposures WHERE unit_id = NEW.unit_id)
BEGIN
  SELECT RAISE(ABORT, 'prompt_reservations: the unit has already been shown');
END;

-- Reservations of unshown units may be released (ended_early, replaced discovery slot); exposed units stay held.
CREATE TRIGGER prompt_reservations_keep_exposed BEFORE DELETE ON prompt_reservations
WHEN EXISTS (SELECT 1 FROM exposures WHERE unit_id = OLD.unit_id)
BEGIN
  SELECT RAISE(ABORT, 'prompt_reservations: an exposed unit cannot be released');
END;

-- Only reserved units can be exposed, and only by a slot of the session that reserved them (reading children share a passage).
CREATE TRIGGER exposures_reserved BEFORE INSERT ON exposures
WHEN NOT EXISTS (
  SELECT 1 FROM prompt_reservations pr
    JOIN session_slots owner ON owner.id = pr.slot_id
    JOIN session_slots shown ON shown.id = NEW.slot_id
   WHERE pr.unit_id = NEW.unit_id AND owner.session_id = shown.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'exposures: the unit is not reserved for this session');
END;

CREATE TRIGGER exposures_no_update BEFORE UPDATE ON exposures BEGIN SELECT RAISE(ABORT, 'exposures is append-only'); END;
CREATE TRIGGER exposures_no_delete BEFORE DELETE ON exposures BEGIN SELECT RAISE(ABORT, 'exposures is append-only'); END;
CREATE TRIGGER scheduling_decisions_no_update BEFORE UPDATE ON scheduling_decisions BEGIN SELECT RAISE(ABORT, 'scheduling_decisions is append-only'); END;
CREATE TRIGGER scheduling_decisions_no_delete BEFORE DELETE ON scheduling_decisions BEGIN SELECT RAISE(ABORT, 'scheduling_decisions is append-only'); END;
