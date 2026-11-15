-- Migration 051: Key Builder, the third Words practice (keybr.com's guided lessons). New tables only.
-- A lesson is one short text of real words and pseudo-words made only of the open letters. Its per-key facts (presses, wrong presses,
-- mean time of the clean presses) are the raw data: open keys, focused key, confidence and the speed forecast are derived from them on
-- every read and never stored. Pseudo-words are never vocabulary: nothing here references words or vocabulary entries.
-- Key Builder time counts as Words activity (journey_typing_intervals mode 'words'), like Finger Drills.
-- Rollback: drop the three tables (no other table references them). Runs inside a runner-managed transaction. Do not edit after it has been applied.

CREATE TABLE typing_key_lessons (
  id            TEXT PRIMARY KEY NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active','completed','interrupted')),
  rules_version TEXT NOT NULL,
  target_cpm    INTEGER NOT NULL CHECK (target_cpm BETWEEN 50 AND 1000),
  -- open letters and the focused one when the lesson was made, and the text (tokens with kind word/pseudo)
  keys_json     TEXT NOT NULL CHECK (json_valid(keys_json)),
  text_json     TEXT NOT NULL CHECK (json_valid(text_json)),
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  active_ms     INTEGER NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  chars_typed   INTEGER NOT NULL DEFAULT 0 CHECK (chars_typed >= 0),
  errors        INTEGER NOT NULL DEFAULT 0 CHECK (errors >= 0),
  CHECK ((status = 'active') = (ended_at IS NULL))
);
CREATE INDEX typing_key_lessons_ended ON typing_key_lessons(status, ended_at);
CREATE UNIQUE INDEX typing_key_lessons_one_active ON typing_key_lessons(status) WHERE status = 'active';
CREATE TRIGGER typing_key_lessons_no_delete BEFORE DELETE ON typing_key_lessons BEGIN SELECT RAISE(ABORT, 'typing_key_lessons is append-only'); END;
CREATE TRIGGER typing_key_lessons_frozen BEFORE UPDATE ON typing_key_lessons
WHEN OLD.status <> 'active'
BEGIN SELECT RAISE(ABORT, 'a finished Key Builder lesson never changes'); END;
CREATE TRIGGER typing_key_lessons_identity BEFORE UPDATE ON typing_key_lessons
WHEN NEW.id IS NOT OLD.id OR NEW.rules_version IS NOT OLD.rules_version OR NEW.target_cpm IS NOT OLD.target_cpm OR NEW.keys_json IS NOT OLD.keys_json
  OR NEW.text_json IS NOT OLD.text_json OR NEW.started_at IS NOT OLD.started_at
  OR NEW.active_ms < OLD.active_ms OR NEW.chars_typed < OLD.chars_typed OR NEW.errors < OLD.errors
BEGIN SELECT RAISE(ABORT, 'typing_key_lessons: identity is fixed and counters only grow'); END;

CREATE TABLE typing_key_hits (
  id        TEXT PRIMARY KEY NOT NULL,
  lesson_id TEXT NOT NULL REFERENCES typing_key_lessons(id) ON DELETE RESTRICT,
  letter    TEXT NOT NULL CHECK (length(letter) = 1 AND letter BETWEEN 'a' AND 'z'),
  hits      INTEGER NOT NULL CHECK (hits >= 0),
  misses    INTEGER NOT NULL CHECK (misses >= 0),
  -- mean time of the clean presses in ms; 0 = no clean press was timed
  mean_ms   INTEGER NOT NULL CHECK (mean_ms >= 0),
  UNIQUE (lesson_id, letter)
);
CREATE TRIGGER typing_key_hits_no_update BEFORE UPDATE ON typing_key_hits BEGIN SELECT RAISE(ABORT, 'typing_key_hits is append-only'); END;
CREATE TRIGGER typing_key_hits_no_delete BEFORE DELETE ON typing_key_hits BEGIN SELECT RAISE(ABORT, 'typing_key_hits is append-only'); END;
CREATE TRIGGER typing_key_hits_guard BEFORE INSERT ON typing_key_hits
WHEN NOT EXISTS (SELECT 1 FROM typing_key_lessons l WHERE l.id = NEW.lesson_id AND l.status = 'completed')
BEGIN SELECT RAISE(ABORT, 'key facts require a completed Key Builder lesson'); END;

CREATE TABLE typing_key_xp_events (
  id           TEXT PRIMARY KEY NOT NULL,
  lesson_id    TEXT NOT NULL UNIQUE REFERENCES typing_key_lessons(id) ON DELETE RESTRICT,
  amount       INTEGER NOT NULL CHECK (amount > 0),
  rule_version TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE TRIGGER typing_key_xp_no_update BEFORE UPDATE ON typing_key_xp_events BEGIN SELECT RAISE(ABORT, 'typing_key_xp_events is append-only'); END;
CREATE TRIGGER typing_key_xp_no_delete BEFORE DELETE ON typing_key_xp_events BEGIN SELECT RAISE(ABORT, 'typing_key_xp_events is append-only'); END;
CREATE TRIGGER typing_key_xp_guard BEFORE INSERT ON typing_key_xp_events
WHEN NOT EXISTS (SELECT 1 FROM typing_key_lessons l WHERE l.id = NEW.lesson_id AND l.status = 'completed')
BEGIN SELECT RAISE(ABORT, 'Key Builder XP requires a completed lesson'); END;
