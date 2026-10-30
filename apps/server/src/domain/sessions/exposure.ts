import type { Db } from "../../db/open.js";
import type { SessionDeps } from "./policy.js";

type Group = "shown" | "answer";

/**
 * Commits exposures (permanent "seen") for the units of a revision. `shown` = prompt/passage/option sentences, written
 * BEFORE the learner is sent the slot; `answer` = accepted-answer sentences, written before feedback/show-answer is sent
 * (spec/04). A unit already exposed is left alone: the global ledger never duplicates and never forgets.
 * Returns how many NEW units were exposed.
 */
export function exposeUnits(db: Db, deps: SessionDeps, slotId: string, revisionId: string, group: Group): number {
  const roles = group === "shown" ? ["prompt", "option", "passage"] : ["answer"];
  const units = db
    .prepare(
      `SELECT DISTINCT rpu.unit_id AS unitId FROM revision_prompt_units rpu
        WHERE rpu.revision_id = ? AND rpu.role IN (${roles.map(() => "?").join(",")})
          AND rpu.unit_id NOT IN (SELECT unit_id FROM exposures)`,
    )
    .all(revisionId, ...roles) as Array<{ unitId: string }>;
  const ins = db.prepare("INSERT INTO exposures(id, unit_id, slot_id, exposed_at) VALUES (?,?,?,?)");
  const at = deps.now().toISOString();
  for (const u of units) ins.run(deps.newId(), u.unitId, slotId, at);
  return units.length;
}
