import { DISCOVERY_V1 } from "@english-lab/learning";
import type { Db } from "../../db/open.js";
import { runDiscovery } from "../analytics/discoveryAdapter.js";
import type { Watermarks } from "./facts.js";

/** Effective status of a finding = the latest review event, else the verdict it was stored with. History is never dropped. */
export interface ReviewStep {
  sequence: number;
  verdict: string;
  reviewer: string;
  reviewVersion: string;
  reason: string;
  at: string;
}
/** AI-detected = produced by a model or not yet confirmed: the list that must never be called "verified mistakes" */
export const isAiDetected = (f: Pick<FindingView, "originalStatus" | "provenance">): boolean => f.provenance.model !== null || f.originalStatus !== "confirmed";

export interface FindingView {
  findingId: string;
  attemptId: string;
  assessmentId: string;
  skillId: string;
  findingType: "grammar" | "style" | "ambiguity";
  span: { start: number | null; end: number | null; unit: "unicode_code_points" };
  correction: string | null;
  explanationRu: string;
  confidence: number | null;
  originalStatus: string;
  effectiveStatus: string;
  /** plain wording that never calls an unverified finding a mistake */
  label: string;
  history: ReviewStep[];
  inputMode: string;
  transcriptEdited: boolean | null;
  contextId: string;
  revisionId: string;
  attemptAt: string;
  isLatestAnalysis: boolean;
  provenance: { model: string | null; digest: string | null; runtime: string | null; runtimeVersion: string | null; prompt: string | null; annotationId: string | null; promptVersionId: string | null };
}

const LABEL: Record<string, string> = {
  tentative: "AI-detected, not verified",
  uncertain: "AI-detected, uncertain",
  confirmed: "Confirmed by review",
  rejected: "Rejected by review",
  disputed: "Disputed",
};

export function listFindings(db: Db, p: { asOf: string; watermarks: Watermarks; limit?: number }): FindingView[] {
  const rows = db
    .prepare(
      `WITH la AS (
         SELECT a.id AS id, a.attempt_id AS attempt_id FROM assessment_revisions a
          WHERE a.rowid <= @w AND a.sequence = (SELECT MAX(b.sequence) FROM assessment_revisions b WHERE b.attempt_id = a.attempt_id AND b.rowid <= @w)
       )
       SELECT e.id AS findingId, ar.attempt_id AS attemptId, e.assessment_id AS assessmentId, sr.skill_id AS skillId, e.finding_type AS findingType, e.fragment_start AS fs, e.fragment_end AS fe,
              e.correction AS correction, e.explanation_ru AS explanationRu, e.confidence AS confidence, e.verdict AS originalStatus,
              COALESCE((SELECT r.verdict FROM finding_review_events r WHERE r.finding_id = e.id AND r.rowid <= @rw ORDER BY r.sequence DESC LIMIT 1), e.verdict) AS effectiveStatus,
              t.input_mode AS inputMode, tr.edited AS edited, er.context_id AS contextId, er.id AS revisionId, t.submitted_at AS attemptAt,
              (e.assessment_id IN (SELECT id FROM la)) AS isLatest,
              mv.tag AS modelTag, mv.digest AS digest, mv.runtime AS runtime, mv.runtime_version AS runtimeVersion,
              ar.ai_annotation_id AS annotationId, an.findings_json AS annotationJson
         FROM error_events e
         JOIN assessment_revisions ar ON ar.id = e.assessment_id AND ar.rowid <= @w
         JOIN skill_revisions sr ON sr.id = e.skill_revision_id
         JOIN attempts t ON t.id = ar.attempt_id AND t.submitted_at <= @asOf
         JOIN session_slots ss ON ss.id = t.slot_id
         JOIN exercise_revisions er ON er.id = ss.exercise_revision_id
         LEFT JOIN transcripts tr ON tr.id = t.transcript_id
         LEFT JOIN model_versions mv ON mv.id = e.model_version_id
         LEFT JOIN ai_annotations an ON an.id = ar.ai_annotation_id
        ORDER BY t.submitted_at DESC, e.id
        LIMIT @limit`,
    )
    .all({ w: p.watermarks.assessments, rw: p.watermarks.reviews, asOf: p.asOf, limit: p.limit ?? 500 }) as Array<Record<string, any>>;
  const hist = db.prepare("SELECT sequence, verdict, reviewer, review_version AS reviewVersion, reason, created_at AS at FROM finding_review_events WHERE finding_id = ? AND rowid <= ? ORDER BY sequence");
  return rows.map((r): FindingView => {
    let prov: { prompt?: string } = {};
    try {
      prov = (JSON.parse(r.annotationJson ?? "{}") as { provenance?: { prompt?: string } }).provenance ?? {};
    } catch {
      /* no annotation */
    }
    return {
      findingId: r.findingId,
      attemptId: r.attemptId,
      assessmentId: r.assessmentId,
      skillId: r.skillId,
      findingType: r.findingType,
      span: { start: r.fs, end: r.fe, unit: "unicode_code_points" },
      correction: r.correction,
      explanationRu: r.explanationRu,
      confidence: r.confidence,
      originalStatus: r.originalStatus,
      effectiveStatus: r.effectiveStatus,
      label: LABEL[r.effectiveStatus] ?? r.effectiveStatus,
      history: hist.all(r.findingId, p.watermarks.reviews) as ReviewStep[],
      inputMode: r.inputMode,
      transcriptEdited: r.edited === null ? null : r.edited === 1,
      contextId: r.contextId,
      revisionId: r.revisionId,
      attemptAt: r.attemptAt,
      isLatestAnalysis: r.isLatest === 1,
      provenance: { model: r.modelTag, digest: r.digest, runtime: r.runtime, runtimeVersion: r.runtimeVersion, prompt: prov.prompt ?? null, annotationId: r.annotationId, promptVersionId: prov.prompt ?? null },
    };
  });
}

export interface DiscoveryAudit {
  version: string;
  enabled: boolean;
  /** why the signal is off, in words */
  disabledReason: string | null;
  config: { windowDays: number; confidenceMin: number; minAttempts: number; minContexts: number; bonusPerAttempt: number; bonusCap: number; qualifiedModels: number };
  skills: Array<{ skillId: string; attempts: number; contexts: number; bonus: number; sourceFindingIds: string[]; qualificationIds: string[] }>;
  note: string;
}

/** What the discovery signal would do right now and why. Read-only; it never changes a score, a state or an exercise. */
export function discoveryAudit(db: Db, p: { asOf: string; taxonomyId: string; watermarks: Watermarks }): DiscoveryAudit {
  const cfg = DISCOVERY_V1;
  const r = runDiscovery(db, { asOf: p.asOf, taxonomyId: p.taxonomyId, watermark: p.watermarks.assessments, reviewWatermark: p.watermarks.reviews, config: cfg });
  const enabled = cfg.qualifiedModels.length > 0;
  return {
    version: cfg.version,
    enabled,
    disabledReason: enabled ? null : "Disabled: model not qualified",
    config: { windowDays: cfg.windowDays, confidenceMin: cfg.confidenceMin, minAttempts: cfg.minAttempts, minContexts: cfg.minContexts, bonusPerAttempt: cfg.bonusPerAttempt, bonusCap: cfg.bonusCap, qualifiedModels: cfg.qualifiedModels.length },
    skills: r.skills.filter((s) => s.k > 0 || s.bonus > 0).map((s) => ({ skillId: s.skillId, attempts: s.k, contexts: s.contexts, bonus: s.bonus, sourceFindingIds: s.sourceFindingIds, qualificationIds: s.qualificationIds })),
    note: "A hint from the AI can nudge which exercise is offered next. It is never evidence, never changes a score, and a rejected or disputed finding removes the nudge.",
  };
}
