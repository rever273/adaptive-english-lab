import type { Db } from "../../db/open.js";
import { nearMatch, nearMatchRationale } from "../content/grader.js";
import { latestAssessment, writeAssessmentRevision, type AttemptRow } from "./assessments.js";
import { loadSlotContext } from "./context.js";
import type { AttemptDeps } from "./ports.js";

/**
 * D64: written answers saved before the near-match rule existed. Each attempt whose latest assessment is still unconfirmed (pending, or a
 * model draft) and that the rule now accepts gets ONE new deterministic revision; the raw attempt and every earlier revision stay as they
 * were. A human revision is never overridden. Idempotent: a confirmed attempt is not looked at again.
 */
export function regradeNearMatches(db: Db, deps: Pick<AttemptDeps, "now" | "newId">): number {
  const rows = db
    .prepare(
      `SELECT t.id AS id, t.slot_id, t.attempt_no, t.first_attempt, t.hints_before, t.answer_seen_before, t.idk, t.criterion_version, t.raw_answer_json AS raw
         FROM attempts t
         JOIN session_slots ss ON ss.id = t.slot_id
         JOIN exercise_revisions er ON er.id = ss.exercise_revision_id
        WHERE t.idk = 0 AND er.type IN ('guided_short_answer','russian_to_english_short')`,
    )
    .all() as Array<AttemptRow & { raw: string | null }>;
  let changed = 0;
  for (const r of rows) {
    const latest = latestAssessment(db, r.id);
    if (!latest || latest.confirmation === "confirmed" || latest.source === "human" || latest.verdict === "disputed") continue;
    const raw = JSON.parse(r.raw ?? "null") as { kind?: string; text?: string } | null;
    if (raw?.kind !== "text" || typeof raw.text !== "string") continue;
    const ctx = loadSlotContext(db, r.slot_id);
    const p = (JSON.parse(ctx.contentJson) as { payload: { accepted_answers?: string[]; rubric?: { target_markers?: string[] } } }).payload;
    const near = nearMatch(raw.text, p.accepted_answers ?? [], p.rubric?.target_markers ?? []);
    if (!near) continue;
    db.transaction(() => {
      const again = latestAssessment(db, r.id);
      if (again?.id !== latest.id) return; // something else wrote meanwhile
      writeAssessmentRevision(db, deps as AttemptDeps, ctx, r, { verdict: "correct", confirmation: "confirmed", source: "deterministic", rationale: nearMatchRationale(near) }, latest);
      changed++;
    }).immediate();
  }
  return changed;
}
