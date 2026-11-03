-- Migration 025 (TASK_026): allow the exercise type 'assemble_sentence' (build a sentence from blocks, for material made from the learner's own thoughts).
-- Rebuilds the immutable parent table only to extend its type constraint: every row is copied unchanged (ids, hashes and content are identical), the
-- two immutability triggers are recreated, and the foreign keys are checked by the migration runner before commit (it disables enforcement outside this
-- transaction, as for migration 020). The runner takes a backup before applying.
-- Rollback: restore the pre-migration backup (the old constraint cannot be restored in place once an 'assemble_sentence' row exists).
-- Runs inside a runner-managed transaction. Do not edit after it has been applied.
CREATE TABLE exercise_revisions_a25 (
  id TEXT PRIMARY KEY NOT NULL,
  exercise_id TEXT NOT NULL REFERENCES exercises(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  schema_version TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('choose_form','choose_missing_fragment','detect_error','guided_short_answer','russian_to_english_short','context_reading','assemble_sentence')),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  content_hash TEXT NOT NULL UNIQUE,
  rubric_version TEXT NOT NULL,
  taxonomy_id TEXT NOT NULL REFERENCES taxonomy_versions(id) ON DELETE RESTRICT,
  dimension TEXT NOT NULL CHECK (dimension IN ('recognition','correction','production')),
  difficulty TEXT NOT NULL CHECK (difficulty IN ('A2','B1','B2','C1','C2')),
  topic TEXT NOT NULL,
  context_id TEXT NOT NULL,
  template_cluster TEXT NOT NULL,
  bank_role TEXT NOT NULL CHECK (bank_role IN ('practice','diagnostic','heldout')),
  created_at TEXT NOT NULL,
  UNIQUE (exercise_id, revision)
);
INSERT INTO exercise_revisions_a25 SELECT * FROM exercise_revisions;
DROP TABLE exercise_revisions;
ALTER TABLE exercise_revisions_a25 RENAME TO exercise_revisions;
CREATE TRIGGER exercise_revisions_no_update BEFORE UPDATE ON exercise_revisions BEGIN SELECT RAISE(ABORT, 'exercise_revisions is immutable; create a new revision'); END;
CREATE TRIGGER exercise_revisions_no_delete BEFORE DELETE ON exercise_revisions BEGIN SELECT RAISE(ABORT, 'exercise_revisions is immutable; create a new revision'); END;
