-- Migration 023: faster reads of `selectable_revisions`. Read-only speed-up: no data, trigger or result changes.
-- 1) The view (migration 004) probes release_items per exercise revision (`ri.revision_id = er.id`), but the primary key (release_id, revision_id)
--    cannot serve that lookup, so every read scanned release_items once per revision: index it by revision.
-- 2) The view joined `latest_content_state`, whose window function re-numbers every content_state_events row on each read. The same "latest event of
--    the revision" is one index lookup (content_state_events_latest) per revision; the rule is unchanged: latest to_status = 'approved' AND an
--    approved review of the same content hash that is released. The column list is unchanged. `latest_content_state` itself stays as it was.
-- Rollback: DROP INDEX release_items_revision; DROP VIEW selectable_revisions; then recreate the view with the definition from migration 004.
-- Runs inside a runner-managed transaction. Do not edit after it has been applied.

CREATE INDEX release_items_revision ON release_items(revision_id);

DROP VIEW selectable_revisions;
CREATE VIEW selectable_revisions AS
SELECT er.id AS revision_id, er.exercise_id, er.type, er.dimension, er.difficulty, er.bank_role, er.content_hash
FROM exercise_revisions er
WHERE (SELECT e.to_status FROM content_state_events e WHERE e.revision_id = er.id ORDER BY e.sequence DESC LIMIT 1) = 'approved'
  AND EXISTS (
    SELECT 1 FROM release_items ri JOIN content_reviews cr ON cr.id = ri.review_id
     WHERE ri.revision_id = er.id AND cr.verdict = 'approved' AND cr.content_hash = er.content_hash
  );
