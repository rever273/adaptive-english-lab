import type { Db } from "../../db/open.js";

/** The cohort a report speaks about (spec/04, spec/09): never mixed across rubric, difficulty or protocol. */
export interface ReportCohort {
  criterionVersion: string;
  difficulty: "A2" | "B1" | "B2" | "C1";
  protocol: "practice" | "diagnostic-v1";
}

export interface Watermarks {
  assessments: number;
  sessionEvents: number;
  errorEvents: number;
  reviews: number;
}

export const currentWatermarks = (db: Db): Watermarks => {
  const m = (t: string) => (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS w FROM ${t}`).get() as { w: number }).w;
  return { assessments: m("assessment_revisions"), sessionEvents: m("session_events"), errorEvents: m("error_events"), reviews: m("finding_review_events") };
};

/** One row per attempt: the LATEST assessment of the attempt at the watermark, plus where and how it was made. */
export interface AttemptFact {
  attemptId: string;
  slotId: string;
  sessionId: string;
  attemptNo: number;
  first: boolean;
  hints: number;
  answerSeen: boolean;
  idk: boolean;
  at: string;
  localDate: string;
  inputMode: string;
  verdict: string;
  confirmation: string;
  assessmentSource: string;
  purpose: string;
  dimension: "recognition" | "correction" | "production";
  format: string;
  difficulty: string;
  criterion: string;
  revisionId: string;
  protocol: "practice" | "diagnostic-v1";
  modelVersionId: string | null;
}

export interface SlotFact {
  slotId: string;
  sessionId: string;
  purpose: string;
  dimension: string;
  difficulty: string;
  criterion: string;
  revealed: boolean;
  skipped: boolean;
  closed: boolean;
}

const protocolOf = (purpose: string): "practice" | "diagnostic-v1" => (purpose === "diagnostic" ? "diagnostic-v1" : "practice");
export const inCohort = (f: { criterion: string; difficulty: string; protocol: string }, c: ReportCohort): boolean => f.criterion === c.criterionVersion && f.difficulty === c.difficulty && f.protocol === c.protocol;

/** cohort null = every attempt (activity, and the list of cohorts that are NOT mixed in) */
export function loadAttemptFacts(db: Db, p: { watermark: number; asOf: string; cohort: ReportCohort | null }): AttemptFact[] {
  const rows = db
    .prepare(
      `WITH la AS (
         SELECT a.*, row_number() OVER (PARTITION BY a.attempt_id ORDER BY a.sequence DESC) AS rn
           FROM assessment_revisions a WHERE a.rowid <= @w
       )
       SELECT t.id AS attemptId, t.slot_id AS slotId, s.id AS sessionId, t.attempt_no AS attemptNo, t.first_attempt AS first, t.hints_before AS hints,
              t.answer_seen_before AS seen, t.idk AS idk, t.submitted_at AS at, t.local_date AS localDate, t.input_mode AS inputMode, t.criterion_version AS criterion,
              la.verdict AS verdict, la.confirmation AS confirmation, la.source AS assessmentSource, la.model_version_id AS modelVersionId,
              s.purpose AS purpose, er.dimension AS dimension, er.type AS format, er.difficulty AS difficulty, er.id AS revisionId
         FROM attempts t
         JOIN la ON la.attempt_id = t.id AND la.rn = 1
         JOIN session_slots ss ON ss.id = t.slot_id
         JOIN sessions s ON s.id = ss.session_id
         JOIN exercise_revisions er ON er.id = ss.exercise_revision_id
        WHERE t.submitted_at <= @asOf
        ORDER BY t.submitted_at, t.id`,
    )
    .all({ w: p.watermark, asOf: p.asOf }) as Array<Record<string, any>>;
  return rows
    .map(
      (r): AttemptFact => ({
        attemptId: r.attemptId,
        slotId: r.slotId,
        sessionId: r.sessionId,
        attemptNo: r.attemptNo,
        first: r.first === 1,
        hints: r.hints,
        answerSeen: r.seen === 1,
        idk: r.idk === 1,
        at: r.at,
        localDate: r.localDate,
        inputMode: r.inputMode,
        verdict: r.verdict,
        confirmation: r.confirmation,
        assessmentSource: r.assessmentSource,
        purpose: r.purpose,
        dimension: r.dimension,
        format: r.format,
        difficulty: r.difficulty,
        criterion: r.criterion,
        revisionId: r.revisionId,
        protocol: protocolOf(r.purpose),
        modelVersionId: r.modelVersionId,
      }),
    )
    .filter((f) => p.cohort === null || inCohort(f, p.cohort));
}

export function loadSlotFacts(db: Db, p: { sessionEventWatermark: number; asOf: string; cohort: ReportCohort }): SlotFact[] {
  const rows = db
    .prepare(
      `SELECT ss.id AS slotId, s.id AS sessionId, s.purpose AS purpose, er.dimension AS dimension, er.difficulty AS difficulty, COALESCE(json_extract(ss.cohort_json, '$.criterionVersion'), er.rubric_version) AS criterion,
              EXISTS (SELECT 1 FROM session_events e WHERE e.slot_id = ss.id AND e.event_type = 'reveal' AND e.rowid <= @w AND e.server_at <= @asOf) AS revealed,
              EXISTS (SELECT 1 FROM session_events e WHERE e.slot_id = ss.id AND e.event_type = 'skip' AND e.rowid <= @w AND e.server_at <= @asOf) AS skipped,
              EXISTS (SELECT 1 FROM session_events e WHERE e.slot_id = ss.id AND e.event_type IN ('skip','continue') AND e.rowid <= @w AND e.server_at <= @asOf) AS closed
         FROM session_slots ss JOIN sessions s ON s.id = ss.session_id JOIN exercise_revisions er ON er.id = ss.exercise_revision_id
        ORDER BY ss.id`,
    )
    .all({ w: p.sessionEventWatermark, asOf: p.asOf }) as Array<Record<string, any>>;
  return rows
    .map((r): SlotFact & { _c: string } => ({ slotId: r.slotId, sessionId: r.sessionId, purpose: r.purpose, dimension: r.dimension, difficulty: r.difficulty, criterion: r.criterion, revealed: r.revealed === 1, skipped: r.skipped === 1, closed: r.closed === 1, _c: protocolOf(r.purpose) }))
    .filter((f) => inCohort({ criterion: f.criterion, difficulty: f.difficulty, protocol: f._c }, p.cohort))
    .map(({ _c, ...rest }) => rest);
}
