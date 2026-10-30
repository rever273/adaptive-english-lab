import { DISCOVERY_V1, computeDiscovery, type DiscoveryConfig, type DiscoverySkillResult, type FindingSignal, type FindingVerdict } from "@english-lab/learning";
import type { Db } from "../../db/open.js";
import { currentWatermark } from "./evidence.js";

export const currentReviewWatermark = (db: Db): number => (db.prepare("SELECT COALESCE(MAX(rowid), 0) AS w FROM finding_review_events").get() as { w: number }).w;

export interface DiscoveryQuery {
  asOf: string;
  taxonomyId: string;
  /** assessment_revisions.rowid watermark */
  watermark?: number;
  /** finding_review_events.rowid watermark: later reviews are not seen (reproducible replay) */
  reviewWatermark?: number;
  config?: DiscoveryConfig;
}

export interface DiscoveryResult {
  config: DiscoveryConfig;
  watermark: number;
  reviewWatermark: number;
  skills: DiscoverySkillResult[];
  /** audit trail for scheduling_decisions (TASK_007) */
  sourceFindingIds: string[];
}

/** Loads finding signals as of the watermarks. Effective verdict = latest review event, else the original verdict. */
export function loadFindingSignals(db: Db, q: { asOf: string; taxonomyId: string; watermark: number; reviewWatermark: number }): FindingSignal[] {
  const rows = db
    .prepare(
      `WITH la AS (
         SELECT a.*, row_number() OVER (PARTITION BY a.attempt_id ORDER BY a.sequence DESC) AS rn
           FROM assessment_revisions a WHERE a.rowid <= @w
       )
       SELECT e.id AS findingId, t.id AS attemptId, sr.skill_id AS skillId, er.context_id AS contextId, e.confidence AS confidence,
              e.finding_type AS findingType,
              COALESCE((SELECT r.verdict FROM finding_review_events r WHERE r.finding_id = e.id AND r.rowid <= @rw ORDER BY r.sequence DESC LIMIT 1), e.verdict) AS effectiveVerdict,
              CASE WHEN mv.id IS NULL THEN NULL ELSE mv.tag || '@' || mv.digest END AS modelKey,
              t.submitted_at AS at, t.first_attempt AS firstAttempt, la.rn AS rn
         FROM error_events e
         JOIN assessment_revisions ar ON ar.id = e.assessment_id AND ar.rowid <= @w
         JOIN la ON la.attempt_id = ar.attempt_id AND la.rn = 1
         JOIN attempts t ON t.id = ar.attempt_id
         JOIN session_slots ss ON ss.id = t.slot_id
         JOIN exercise_revisions er ON er.id = ss.exercise_revision_id
         JOIN skill_revisions sr ON sr.id = e.skill_revision_id AND sr.taxonomy_id = @tax
         LEFT JOIN model_versions mv ON mv.id = e.model_version_id
        WHERE t.submitted_at <= @asOf
        ORDER BY e.id`,
    )
    .all({ w: q.watermark, rw: q.reviewWatermark, tax: q.taxonomyId, asOf: q.asOf }) as Array<{
    findingId: string;
    attemptId: string;
    skillId: string;
    contextId: string;
    confidence: number | null;
    findingType: "grammar" | "style" | "ambiguity";
    effectiveVerdict: FindingVerdict;
    modelKey: string | null;
    at: string;
    firstAttempt: number;
    rn: number;
  }>;
  const latestIds = new Set(
    (db.prepare("SELECT a.id FROM assessment_revisions a WHERE a.rowid <= ? AND a.sequence = (SELECT MAX(b.sequence) FROM assessment_revisions b WHERE b.attempt_id = a.attempt_id AND b.rowid <= ?)").all(q.watermark, q.watermark) as Array<{ id: string }>).map((r) => r.id),
  );
  const assessmentOf = new Map((db.prepare("SELECT id, assessment_id FROM error_events").all() as Array<{ id: string; assessment_id: string }>).map((r) => [r.id, r.assessment_id]));
  return rows.map((r) => ({
    findingId: r.findingId,
    attemptId: r.attemptId,
    skillId: r.skillId,
    contextId: r.contextId,
    confidence: r.confidence,
    findingType: r.findingType,
    effectiveVerdict: r.effectiveVerdict,
    skillKnown: true, // the join above only yields skills of the taxonomy; unknown skills cannot be stored (FK)
    modelKey: r.modelKey,
    at: r.at,
    firstAttempt: r.firstAttempt === 1,
    latestAnalysis: latestIds.has(assessmentOf.get(r.findingId) ?? ""),
  }));
}

/**
 * Last confirmed independent answer per skill (recognition/correction), used as "last confirmed probe". Until
 * scheduling_decisions exist (TASK_007) any confirmed unaided answer on the skill counts as the probe that closes a hypothesis.
 */
export function lastConfirmedProbeBySkill(db: Db, q: { asOf: string; taxonomyId: string; watermark: number }): Record<string, string> {
  const rows = db
    .prepare(
      `WITH la AS (
         SELECT a.*, row_number() OVER (PARTITION BY a.attempt_id ORDER BY a.sequence DESC) AS rn
           FROM assessment_revisions a WHERE a.rowid <= @w
       )
       SELECT sr.skill_id AS skillId, MAX(t.submitted_at) AS at
         FROM skill_opportunities o
         JOIN la ON la.id = o.assessment_id AND la.rn = 1
         JOIN attempts t ON t.id = la.attempt_id
         JOIN skill_revisions sr ON sr.id = o.skill_revision_id AND sr.taxonomy_id = @tax
        WHERE la.confirmation = 'confirmed' AND la.verdict IN ('correct','incorrect','idk')
          AND o.target = 1 AND o.dimension IN ('recognition','correction') AND o.reliability = 'confirmed'
          AND t.first_attempt = 1 AND t.hints_before = 0 AND t.answer_seen_before = 0 AND t.submitted_at <= @asOf
        GROUP BY sr.skill_id`,
    )
    .all({ w: q.watermark, tax: q.taxonomyId, asOf: q.asOf }) as Array<{ skillId: string; at: string }>;
  return Object.fromEntries(rows.map((r) => [r.skillId, r.at]));
}

export function runDiscovery(db: Db, q: DiscoveryQuery): DiscoveryResult {
  const config = q.config ?? DISCOVERY_V1;
  const watermark = q.watermark ?? currentWatermark(db);
  const reviewWatermark = q.reviewWatermark ?? currentReviewWatermark(db);
  const asOf = new Date(q.asOf).toISOString();
  const signals = loadFindingSignals(db, { asOf, taxonomyId: q.taxonomyId, watermark, reviewWatermark });
  const probes = lastConfirmedProbeBySkill(db, { asOf, taxonomyId: q.taxonomyId, watermark });
  const skills = computeDiscovery(signals, probes, asOf, config);
  return { config, watermark, reviewWatermark, skills, sourceFindingIds: skills.flatMap((s) => s.sourceFindingIds).sort() };
}
