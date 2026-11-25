-- Migration 056: Grammar Cloze background check, themed sessions and hints.
--  * The local model checks sentences in the background (prompt grammar-cloze-audit-v1). Its opinion is stored in the existing
--    grammar_cloze_ai_analyses table (one row per revision and prompt version, frozen once finished). A sentence whose finished check says
--    anything but "key_ok" is hidden from new sessions and does not move to the next stage. It is never deleted, approved or rewritten.
--  * grammar_cloze_audit_overrides: the learner's own decision in Content Studio (restore a hidden sentence or hide one by hand). Append-only;
--    the latest row for the current revision wins. A new revision of the sentence starts without an override.
--  * grammar_cloze_audit_control: the single on/off switch of the background check (the learner's Start/Pause).
--  * grammar_cloze_sessions.plan_json: the theme of a session (focus family and review rules), written once when the session is created.
--  * grammar_cloze_attempts.hint_level: how much help was shown before the answer (0 none, 1 signal words, 2 the rule name). A correct answer
--    with a hint stays correct (it does not move to the next stage) but earns less XP.
-- Existing rows keep their meaning: old sessions have no plan, old attempts had no hints (0).
-- Runs inside a runner-managed transaction. Do not edit after it has been applied. Rollback: restore the pre-migration backup.

CREATE TABLE grammar_cloze_audit_overrides (
  id          TEXT PRIMARY KEY NOT NULL,
  item_id     TEXT NOT NULL REFERENCES grammar_cloze_items(id) ON DELETE RESTRICT,
  revision_id TEXT NOT NULL REFERENCES grammar_cloze_revisions(id) ON DELETE RESTRICT,
  action      TEXT NOT NULL CHECK (action IN ('restore','hide')),
  created_at  TEXT NOT NULL
);
CREATE INDEX grammar_cloze_audit_overrides_item ON grammar_cloze_audit_overrides(item_id, revision_id, created_at);
CREATE TRIGGER grammar_cloze_audit_overrides_no_update BEFORE UPDATE ON grammar_cloze_audit_overrides BEGIN SELECT RAISE(ABORT, 'grammar_cloze_audit_overrides is append-only'); END;
CREATE TRIGGER grammar_cloze_audit_overrides_no_delete BEFORE DELETE ON grammar_cloze_audit_overrides BEGIN SELECT RAISE(ABORT, 'grammar_cloze_audit_overrides is append-only'); END;

CREATE TABLE grammar_cloze_audit_control (
  id         INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  enabled    INTEGER NOT NULL CHECK (enabled IN (0,1)),
  updated_at TEXT NOT NULL
);
INSERT INTO grammar_cloze_audit_control(id, enabled, updated_at) VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TRIGGER grammar_cloze_audit_control_no_delete BEFORE DELETE ON grammar_cloze_audit_control BEGIN SELECT RAISE(ABORT, 'grammar_cloze_audit_control is never deleted'); END;

CREATE INDEX grammar_cloze_ai_revision ON grammar_cloze_ai_analyses(revision_id, prompt_version, status);

ALTER TABLE grammar_cloze_sessions ADD COLUMN plan_json TEXT CHECK (plan_json IS NULL OR json_valid(plan_json));
CREATE TRIGGER grammar_cloze_sessions_plan_fixed BEFORE UPDATE OF plan_json ON grammar_cloze_sessions WHEN NEW.plan_json IS NOT OLD.plan_json
BEGIN SELECT RAISE(ABORT, 'grammar_cloze_sessions: the plan is fixed'); END;

ALTER TABLE grammar_cloze_attempts ADD COLUMN hint_level INTEGER NOT NULL DEFAULT 0 CHECK (hint_level BETWEEN 0 AND 2);
