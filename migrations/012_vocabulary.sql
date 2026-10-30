-- Migration 012: vocabulary (spec/03, spec/08, TASK_015, DECISION_LOG D57).
-- A word is saved the moment the learner asks, with or without any AI. Meaning text is append-only revisions; a USER revision always wins over a
-- model draft field by field, so a late model result can never overwrite what the learner wrote. `learned` is a plain flag: nothing in scoring,
-- selection or Mastery reads it. Encounters are counted twice, on purpose, and never mixed: BANK (the word occurs in an approved exercise) and
-- DISPLAYED (it was actually shown in a slot; one slot is one encounter per occurrence however often the page re-renders).
-- No schedule, no flashcards, no spaced repetition. Runs inside a runner-managed transaction. Do not edit after it has been applied.

CREATE TABLE vocabulary_entries (
  id                 TEXT PRIMARY KEY NOT NULL,
  lemma              TEXT NOT NULL CHECK (length(lemma) BETWEEN 1 AND 60),
  pos                TEXT NOT NULL CHECK (length(pos) BETWEEN 1 AND 30),
  language           TEXT NOT NULL CHECK (language = 'en'),
  learned            INTEGER NOT NULL DEFAULT 0 CHECK (learned IN (0,1)),
  -- number of USER edits so far: the optimistic-concurrency token (PATCH must name the revision it read)
  user_revision      INTEGER NOT NULL DEFAULT 0 CHECK (user_revision >= 0),
  -- the forms the learner actually selected (e.g. "stopped"), used with the lemma to find the word in exercises
  surface_forms_json TEXT NOT NULL CHECK (json_valid(surface_forms_json)),
  created_at         TEXT NOT NULL,
  UNIQUE (lemma, pos, language)
);

CREATE TABLE vocabulary_revisions (
  id                 TEXT PRIMARY KEY NOT NULL,
  entry_id           TEXT NOT NULL REFERENCES vocabulary_entries(id) ON DELETE RESTRICT,
  revision           INTEGER NOT NULL CHECK (revision > 0),
  translation_ru     TEXT NOT NULL,
  part_of_speech     TEXT NOT NULL,
  example_en         TEXT NOT NULL,
  collocations_json  TEXT NOT NULL CHECK (json_valid(collocations_json)),
  source             TEXT NOT NULL CHECK (source IN ('user','model','agent')),
  -- model text is only ever a draft; a user's own text is 'approved' (it is theirs)
  status             TEXT NOT NULL CHECK (status IN ('draft','validated','pending_review','approved','flagged','rejected')),
  user_edited        INTEGER NOT NULL CHECK (user_edited IN (0,1)),
  -- for model drafts: the entry's user_revision when the job was queued (shows a draft that predates the learner's last edit)
  based_on_user_rev  INTEGER,
  job_result_id      TEXT REFERENCES job_results(id) ON DELETE RESTRICT,
  created_at         TEXT NOT NULL,
  UNIQUE (entry_id, revision),
  CHECK (source <> 'model' OR (status = 'draft' AND user_edited = 0)),
  CHECK (source <> 'user' OR user_edited = 1)
);
CREATE INDEX vocabulary_revisions_entry ON vocabulary_revisions(entry_id, revision);

CREATE TABLE vocabulary_encounters (
  id               TEXT PRIMARY KEY NOT NULL,
  entry_id         TEXT NOT NULL REFERENCES vocabulary_entries(id) ON DELETE RESTRICT,
  revision_id      TEXT NOT NULL REFERENCES exercise_revisions(id) ON DELETE RESTRICT,
  slot_id          TEXT REFERENCES session_slots(id) ON DELETE RESTRICT,
  kind             TEXT NOT NULL CHECK (kind IN ('bank','displayed')),
  occurrence_index INTEGER NOT NULL CHECK (occurrence_index >= 0),
  created_at       TEXT NOT NULL,
  CHECK ((kind = 'bank' AND slot_id IS NULL) OR (kind = 'displayed' AND slot_id IS NOT NULL))
);
CREATE UNIQUE INDEX vocabulary_encounters_unique ON vocabulary_encounters(entry_id, revision_id, COALESCE(slot_id, ''), kind, occurrence_index);
CREATE INDEX vocabulary_encounters_entry ON vocabulary_encounters(entry_id, kind);

-- history is append-only; the entry row may change only in `learned`, `pos`, `user_revision` and `surface_forms_json`
CREATE TRIGGER vocabulary_revisions_no_update BEFORE UPDATE ON vocabulary_revisions BEGIN SELECT RAISE(ABORT, 'vocabulary_revisions is append-only'); END;
CREATE TRIGGER vocabulary_revisions_no_delete BEFORE DELETE ON vocabulary_revisions BEGIN SELECT RAISE(ABORT, 'vocabulary_revisions is append-only'); END;
CREATE TRIGGER vocabulary_encounters_no_update BEFORE UPDATE ON vocabulary_encounters BEGIN SELECT RAISE(ABORT, 'vocabulary_encounters is append-only'); END;
CREATE TRIGGER vocabulary_encounters_no_delete BEFORE DELETE ON vocabulary_encounters BEGIN SELECT RAISE(ABORT, 'vocabulary_encounters is append-only'); END;
CREATE TRIGGER vocabulary_entries_no_delete BEFORE DELETE ON vocabulary_entries BEGIN SELECT RAISE(ABORT, 'vocabulary_entries is never deleted'); END;
CREATE TRIGGER vocabulary_entries_update BEFORE UPDATE ON vocabulary_entries
WHEN NEW.id <> OLD.id OR NEW.lemma <> OLD.lemma OR NEW.language <> OLD.language OR NEW.created_at <> OLD.created_at OR NEW.user_revision < OLD.user_revision
BEGIN
  SELECT RAISE(ABORT, 'vocabulary_entries: lemma, language and history never change; user_revision only grows');
END;
