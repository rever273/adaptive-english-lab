import type { Db } from "../../db/open.js";
import type { Dimension, EvidenceOpportunity } from "@english-lab/learning";

/**
 * Cohorts are never mixed (spec/04): same rubric/criterion version, difficulty AND protocol. `practice` (default) holds practice sessions and their
 * delayed held-out checks; `diagnostic-v1` holds only the starting diagnostic blocks, so a diagnostic never moves a practice score or the reverse.
 */
export interface Cohort {
  criterionVersion: string;
  difficulty: "A2" | "B1" | "B2" | "C1";
  protocol?: "practice" | "diagnostic-v1";
}

export interface RawEvidenceRow {
  id: string;
  skillId: string;
  dimension: Dimension;
  at: string;
  localDate: string;
  success: boolean;
  heldout: boolean;
  /** D65: decided by the local AI, never confirmed (only produced when provisional evidence is requested) */
  aiChecked?: boolean;
}

export const currentWatermark = (db: Db): number => (db.prepare("SELECT COALESCE(MAX(rowid), 0) AS w FROM assessment_revisions").get() as { w: number }).w;

/**
 * Confirmed unaided evidence as it was at `watermark` (highest assessment_revisions.rowid): only the latest revision of
 * each attempt counts, so a later correction or dispute moves the evidence in new runs while old runs stay replayable.
 * Same filter as the confirmed_opportunities view (spec/09) plus cohort, as_of and watermark.
 */
export function loadEvidence(db: Db, p: { watermark: number; asOf: string; taxonomyId: string; cohort: Cohort; provisional?: boolean }): RawEvidenceRow[] {
  // D65 (+ asymmetry): with `provisional`, a decided MODEL "correct" that no code/human revision has superseded also counts, flagged aiChecked.
  // A model "incorrect" never counts until an agent/human confirms it (the model's false-positive rate on correct sentences was ~4-11%).
  // It never becomes 'confirmed'; the default (confirmed only) query text is unchanged.
  const gate = p.provisional
    ? `((la.confirmation = 'confirmed' AND la.verdict IN ('correct','incorrect','idk') AND o.reliability = 'confirmed')
         OR (la.source = 'model' AND la.confirmation = 'tentative' AND la.verdict = 'correct' AND o.reliability = 'tentative'))`
    : `(la.confirmation = 'confirmed' AND la.verdict IN ('correct','incorrect','idk') AND o.reliability = 'confirmed')`;
  const rows = db
    .prepare(
      `WITH la AS (
         SELECT a.*, row_number() OVER (PARTITION BY a.attempt_id ORDER BY a.sequence DESC) AS rn
           FROM assessment_revisions a WHERE a.rowid <= @w
       )
       SELECT o.id AS id, sr.skill_id AS skillId, o.dimension AS dimension, t.submitted_at AS at, t.local_date AS localDate,
              o.result AS result, s.purpose AS purpose, (la.confirmation <> 'confirmed') AS ai
         FROM skill_opportunities o
         JOIN la ON la.id = o.assessment_id AND la.rn = 1
         JOIN attempts t ON t.id = la.attempt_id
         JOIN session_slots ss ON ss.id = t.slot_id
         JOIN sessions s ON s.id = ss.session_id
         JOIN exercise_revisions er ON er.id = ss.exercise_revision_id
         JOIN skill_revisions sr ON sr.id = o.skill_revision_id
        WHERE ${gate}
          AND o.target = 1 AND o.independent = 1
          AND o.opportunity_type = 'explicit' AND o.result IN ('success','failure','idk')
          AND t.first_attempt = 1 AND t.hints_before = 0 AND t.answer_seen_before = 0
          AND t.submitted_at <= @asOf AND t.criterion_version = @crit AND er.difficulty = @diff AND sr.taxonomy_id = @tax
          AND (CASE WHEN @proto = 'diagnostic-v1' THEN s.purpose = 'diagnostic' ELSE s.purpose <> 'diagnostic' END)
        ORDER BY t.submitted_at, o.id`,
    )
    .all({ w: p.watermark, asOf: p.asOf, crit: p.cohort.criterionVersion, diff: p.cohort.difficulty, tax: p.taxonomyId, proto: p.cohort.protocol ?? "practice" }) as Array<{
    id: string;
    skillId: string;
    dimension: Dimension;
    at: string;
    localDate: string;
    result: string;
    purpose: string;
    ai: number;
  }>;
  return rows.map((r) => ({ id: r.id, skillId: r.skillId, dimension: r.dimension, at: r.at, localDate: r.localDate, success: r.result === "success", heldout: r.purpose === "heldout", ...(r.ai === 1 ? { aiChecked: true } : {}) }));
}

/** Every practice moment per skill x dimension (any attempt on a target opportunity, assisted or not): input for delayed-probe detection. */
export function loadActivity(db: Db, p: { watermark: number; asOf: string; taxonomyId: string }): Map<string, string[]> {
  const rows = db
    .prepare(
      `SELECT DISTINCT sr.skill_id AS skillId, o.dimension AS dimension, t.submitted_at AS at, t.id AS attemptId
         FROM skill_opportunities o
         JOIN assessment_revisions a ON a.id = o.assessment_id AND a.rowid <= @w
         JOIN attempts t ON t.id = a.attempt_id
         JOIN session_slots ss ON ss.id = t.slot_id
         JOIN skill_revisions sr ON sr.id = o.skill_revision_id
        WHERE o.target = 1 AND t.submitted_at <= @asOf AND sr.taxonomy_id = @tax
          AND COALESCE(json_extract(ss.cohort_json, '$.repeat'), 0) <> 1 -- D68: repeats are not practice moments for delayed probes
        ORDER BY t.submitted_at`,
    )
    .all({ w: p.watermark, asOf: p.asOf, tax: p.taxonomyId }) as Array<{ skillId: string; dimension: string; at: string }>;
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const k = `${r.skillId}|${r.dimension}`;
    (out.get(k) ?? out.set(k, []).get(k)!).push(r.at);
  }
  return out;
}

export type { EvidenceOpportunity };

/**
 * Starting-diagnostic outcomes per skill (D62): the same confirmed, unaided, first-attempt filter as loadEvidence, any cohort, only
 * sessions with purpose 'diagnostic'. Feeds the selection prior; never Mastery.
 */
export function loadDiagnosticOutcomes(db: Db, p: { watermark: number; asOf: string; taxonomyId: string }): Map<string, { attempts: number; failures: number }> {
  const rows = db
    .prepare(
      `WITH la AS (
         SELECT a.*, row_number() OVER (PARTITION BY a.attempt_id ORDER BY a.sequence DESC) AS rn
           FROM assessment_revisions a WHERE a.rowid <= @w
       )
       SELECT sr.skill_id AS skillId, COUNT(*) AS attempts, SUM(CASE WHEN o.result = 'success' THEN 0 ELSE 1 END) AS failures
         FROM skill_opportunities o
         JOIN la ON la.id = o.assessment_id AND la.rn = 1
         JOIN attempts t ON t.id = la.attempt_id
         JOIN session_slots ss ON ss.id = t.slot_id
         JOIN sessions s ON s.id = ss.session_id
         JOIN skill_revisions sr ON sr.id = o.skill_revision_id
        WHERE la.confirmation = 'confirmed' AND la.verdict IN ('correct','incorrect','idk')
          AND o.reliability = 'confirmed' AND o.target = 1 AND o.independent = 1
          AND o.opportunity_type = 'explicit' AND o.result IN ('success','failure','idk')
          AND t.first_attempt = 1 AND t.hints_before = 0 AND t.answer_seen_before = 0
          AND t.submitted_at <= @asOf AND sr.taxonomy_id = @tax AND s.purpose = 'diagnostic'
        GROUP BY sr.skill_id ORDER BY sr.skill_id`,
    )
    .all({ w: p.watermark, asOf: p.asOf, tax: p.taxonomyId }) as Array<{ skillId: string; attempts: number; failures: number }>;
  return new Map(rows.map((r) => [r.skillId, { attempts: r.attempts, failures: r.failures }]));
}
