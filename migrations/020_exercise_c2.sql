-- Rebuild the immutable parent table to extend its difficulty constraint. The migration runner
-- temporarily disables FK enforcement outside this transaction and checks all FKs before commit.
CREATE TABLE exercise_revisions_c2 (
  id TEXT PRIMARY KEY NOT NULL,
  exercise_id TEXT NOT NULL REFERENCES exercises(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  schema_version TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('choose_form','choose_missing_fragment','detect_error','guided_short_answer','russian_to_english_short','context_reading')),
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
INSERT INTO exercise_revisions_c2 SELECT * FROM exercise_revisions;
DROP TABLE exercise_revisions;
ALTER TABLE exercise_revisions_c2 RENAME TO exercise_revisions;
CREATE TRIGGER exercise_revisions_no_update BEFORE UPDATE ON exercise_revisions BEGIN SELECT RAISE(ABORT, 'exercise_revisions is immutable; create a new revision'); END;
CREATE TRIGGER exercise_revisions_no_delete BEFORE DELETE ON exercise_revisions BEGIN SELECT RAISE(ABORT, 'exercise_revisions is immutable; create a new revision'); END;

-- A new default revision applies only when the user never chose either bound. Older revisions
-- remain untouched so existing sessions continue to use their historical settings.
INSERT INTO settings_revisions(id, revision, values_json, created_at)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),
       revision + 1, json_set(values_json, '$.difficultyMin', 'B1', '$.difficultyMax', 'C1'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM settings_revisions
WHERE revision = (SELECT MAX(revision) FROM settings_revisions)
  AND json_type(values_json, '$.difficultyMin') IS NULL
  AND json_type(values_json, '$.difficultyMax') IS NULL;
