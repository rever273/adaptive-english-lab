import type { Db } from "../../db/open.js";
import { PLAYABLE_BLUEPRINT_STATUSES } from "./policy.js";

/** Current revision of each lesson, with counts from every revision of its stable identity. */
export function courseLessons(db: Db): Array<{ id: string; key: string; status: string; completed: number; unlocked: boolean }> {
  const rows = db.prepare(`SELECT br.id, b.stable_key AS key, br.status,
    (SELECT COUNT(*) FROM sessions s JOIN blueprint_revisions old ON old.id = s.blueprint_revision_id
      WHERE old.blueprint_id = b.id AND s.purpose = 'practice' AND s.status = 'completed'
        AND NOT EXISTS (SELECT 1 FROM vocabulary_sessions v WHERE v.session_id = s.id)) AS completed
    FROM blueprint_revisions br JOIN blueprints b ON b.id = br.blueprint_id
    WHERE br.revision = (SELECT MAX(x.revision) FROM blueprint_revisions x WHERE x.blueprint_id = b.id)`)
    .all() as Array<{ id: string; key: string; status: string; completed: number }>;
  const ordered = rows.filter((r) => PLAYABLE_BLUEPRINT_STATUSES.has(r.status)).sort((a, b) => {
    const number = (key: string) => Number(/(?:^|[-_])l(\d+)$/i.exec(key)?.[1] ?? Number.MAX_SAFE_INTEGER);
    return number(a.key) - number(b.key) || a.key.localeCompare(b.key);
  });
  let furthest = -1;
  ordered.forEach((r, i) => { if (r.completed > 0) furthest = i; });
  return ordered.map((r, i) => ({ ...r, unlocked: i <= furthest + 1 }));
}
