import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { isIndependent } from "./canonical.js";
import { loadSlotContext, resolveTargetSkillKey, skillRevisionId, type SlotContext } from "./context.js";
import type { AssessmentDecision, AttemptDeps, Confirmation, FindingInput } from "./ports.js";

export interface AttemptRow {
  id: string;
  slot_id: string;
  attempt_no: number;
  first_attempt: number;
  hints_before: number;
  answer_seen_before: number;
  idk: number;
  criterion_version: string;
}

export interface AssessmentRow {
  id: string;
  attempt_id: string;
  sequence: number;
  source: "deterministic" | "model" | "human";
  verdict: string;
  confirmation: Confirmation;
  criterion_version: string;
}

const DETERMINATE = new Set(["correct", "incorrect", "idk"]);

export function latestAssessment(db: Db, attemptId: string): AssessmentRow | undefined {
  return db.prepare("SELECT * FROM assessment_revisions WHERE attempt_id = ? ORDER BY sequence DESC LIMIT 1").get(attemptId) as AssessmentRow | undefined;
}

function reliabilityOf(c: Confirmation): "confirmed" | "tentative" | "uncertain" | null {
  return c === "confirmed" || c === "tentative" || c === "uncertain" ? c : null;
}

function assertDecision(d: AssessmentDecision): void {
  if (d.source === "model") {
    if (d.confirmation === "confirmed") {
      throw new ApiError(422, "MODEL_CANNOT_CONFIRM", "Model output can never be confirmed on its own authority");
    }
    if (d.findings?.some((f) => f.verdict === "confirmed")) {
      throw new ApiError(422, "MODEL_CANNOT_CONFIRM", "Model findings can never be confirmed on their own authority");
    }
  }
  if (d.verdict === "pending" && d.confirmation === "confirmed") {
    throw new ApiError(422, "INVALID_ASSESSMENT", "A pending verdict cannot be confirmed");
  }
}

function insertFinding(db: Db, deps: AttemptDeps, ctx: SlotContext, assessmentId: string, f: FindingInput): void {
  db.prepare(
    `INSERT INTO error_events(id, assessment_id, skill_revision_id, fragment_start, fragment_end, correction, explanation_ru,
                              finding_type, verdict, confidence, model_version_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    deps.newId(),
    assessmentId,
    skillRevisionId(db, f.skillId, ctx.taxonomyId),
    f.fragmentStart ?? null,
    f.fragmentEnd ?? null,
    f.correction ?? null,
    f.explanationRu,
    f.findingType,
    f.verdict,
    f.confidence ?? null,
    f.modelVersionId ?? null,
    deps.now().toISOString(),
  );
}

function insertOpportunity(
  db: Db,
  deps: AttemptDeps,
  o: {
    assessmentId: string;
    skillRevisionId: string;
    dimension: string;
    target: boolean;
    reliability: string;
    result: string;
    independent: boolean;
    evidenceGroup: string;
  },
): void {
  db.prepare(
    `INSERT INTO skill_opportunities(id, assessment_id, skill_revision_id, dimension, target, opportunity_type, reliability, result, independent, evidence_group)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    deps.newId(),
    o.assessmentId,
    o.skillRevisionId,
    o.dimension,
    o.target ? 1 : 0,
    o.target ? "explicit" : "observed",
    o.reliability,
    o.result,
    o.independent ? 1 : 0,
    o.evidenceGroup,
  );
}

/**
 * Appends the next assessment revision of an attempt (never updates an earlier one), with its findings and
 * evidence rows. Evidence is recorded, not scored: Mastery is computed later from these rows by code (TASK_005).
 * Must run inside the caller's transaction.
 */
export function writeAssessmentRevision(
  db: Db,
  deps: AttemptDeps,
  ctx: SlotContext,
  attempt: AttemptRow,
  decision: AssessmentDecision,
  previous: AssessmentRow | undefined,
): AssessmentRow {
  assertDecision(decision);
  const id = deps.newId();
  const sequence = (previous?.sequence ?? 0) + 1;
  db.prepare(
    `INSERT INTO assessment_revisions(id, attempt_id, sequence, source, verdict, confirmation, criterion_version, model_version_id, supersedes_id, rationale, created_at, ai_annotation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    attempt.id,
    sequence,
    decision.source,
    decision.verdict,
    decision.confirmation,
    attempt.criterion_version,
    decision.modelVersionId ?? null,
    previous?.id ?? null,
    decision.rationale,
    deps.now().toISOString(),
    decision.aiAnnotationId ?? null,
  );

  // Vocabulary assessments share the immutable assessment ledger but are not grammar evidence.
  const vocabulary = db.prepare("SELECT 1 FROM vocabulary_sessions WHERE session_id = ?").get(ctx.sessionId) !== undefined;
  if (vocabulary) {
    return { id, attempt_id: attempt.id, sequence, source: decision.source, verdict: decision.verdict, confirmation: decision.confirmation, criterion_version: attempt.criterion_version };
  }
  for (const f of decision.findings ?? []) insertFinding(db, deps, ctx, id, f);

  if (DETERMINATE.has(decision.verdict)) {
    const independent = isIndependent({
      firstAttempt: attempt.first_attempt === 1,
      hintsBefore: attempt.hints_before,
      answerSeenBefore: attempt.answer_seen_before === 1,
    });
    const evidenceGroup = ctx.questionId ? `${ctx.slotId}:${ctx.questionId}` : ctx.slotId;
    const targetKey = resolveTargetSkillKey(ctx);
    const reliability = reliabilityOf(decision.confirmation) ?? "uncertain";
    insertOpportunity(db, deps, {
      assessmentId: id,
      skillRevisionId: skillRevisionId(db, targetKey, ctx.taxonomyId),
      dimension: ctx.dimension,
      target: true,
      reliability,
      result: decision.verdict === "correct" ? "success" : decision.verdict === "idk" ? "idk" : "failure",
      independent,
      evidenceGroup,
    });
    // One failed attempt, several distinct skill findings: extra grammar skills become observed non-target evidence.
    const seen = new Set<string>([targetKey]);
    for (const f of decision.findings ?? []) {
      const rel = reliabilityOf(f.verdict);
      if (f.findingType !== "grammar" || rel === null || seen.has(f.skillId)) continue;
      seen.add(f.skillId);
      insertOpportunity(db, deps, {
        assessmentId: id,
        skillRevisionId: skillRevisionId(db, f.skillId, ctx.taxonomyId),
        dimension: ctx.dimension,
        target: false,
        reliability: rel,
        result: "failure",
        independent,
        evidenceGroup,
      });
    }
  }
  return { id, attempt_id: attempt.id, sequence, source: decision.source, verdict: decision.verdict, confirmation: decision.confirmation, criterion_version: attempt.criterion_version };
}

function loadAttempt(db: Db, attemptId: string): AttemptRow {
  const a = db.prepare("SELECT id, slot_id, attempt_no, first_attempt, hints_before, answer_seen_before, idk, criterion_version FROM attempts WHERE id = ?").get(attemptId) as AttemptRow | undefined;
  if (!a) throw new ApiError(404, "ATTEMPT_NOT_FOUND", "Unknown attempt");
  return a;
}

export interface AppendAssessmentInput {
  attemptId: string;
  /** Optimistic compare: the sequence the caller last saw. A different latest sequence is a 409. */
  expectedSequence: number;
  decision: AssessmentDecision;
}

/** Re-assessment / human correction: appends a revision; the raw attempt and earlier revisions stay untouched. */
export function appendAssessmentRevision(db: Db, deps: AttemptDeps, input: AppendAssessmentInput): AssessmentRow {
  return db
    .transaction(() => {
      const attempt = loadAttempt(db, input.attemptId);
      const prev = latestAssessment(db, attempt.id);
      if ((prev?.sequence ?? 0) !== input.expectedSequence) {
        throw new ApiError(409, "STALE_ASSESSMENT", "The assessment changed since it was read", { latestSequence: prev?.sequence ?? 0 });
      }
      const ctx = loadSlotContext(db, attempt.slot_id);
      return writeAssessmentRevision(db, deps, ctx, attempt, input.decision, prev);
    })
    .immediate();
}

export interface DisputeResult {
  disputeId: string;
  attemptId: string;
  assessment: AssessmentRow;
}

/**
 * Dispute = append a `disputed` revision (so the confirmed projection drops the evidence) plus a dispute record.
 * Only the latest revision can be disputed; a stale id is a 409.
 */
export function disputeAssessment(db: Db, deps: AttemptDeps, input: { assessmentId: string; reason: string }): DisputeResult {
  return db
    .transaction(() => {
      const target = db.prepare("SELECT * FROM assessment_revisions WHERE id = ?").get(input.assessmentId) as AssessmentRow | undefined;
      if (!target) throw new ApiError(404, "ASSESSMENT_NOT_FOUND", "Unknown assessment");
      const attempt = loadAttempt(db, target.attempt_id);
      const latest = latestAssessment(db, attempt.id)!;
      if (latest.id !== target.id) {
        throw new ApiError(409, "STALE_ASSESSMENT", "Only the latest assessment revision can be disputed", { latestSequence: latest.sequence });
      }
      if (latest.verdict === "disputed") throw new ApiError(409, "ALREADY_DISPUTED", "This assessment is already disputed");
      const ctx = loadSlotContext(db, attempt.slot_id);
      const revision = writeAssessmentRevision(
        db,
        deps,
        ctx,
        attempt,
        { verdict: "disputed", confirmation: "disputed", source: "human", rationale: input.reason },
        latest,
      );
      const disputeId = deps.newId();
      db.prepare("INSERT INTO assessment_disputes(id, assessment_id, reason, created_at) VALUES (?,?,?,?)").run(disputeId, target.id, input.reason, deps.now().toISOString());
      return { disputeId, attemptId: attempt.id, assessment: revision };
    })
    .immediate();
}

/** Links a dispute to the revision that resolved it (the only mutable column in this area, set once). */
export function resolveDispute(db: Db, input: { disputeId: string; resolutionAssessmentId: string }): void {
  db.transaction(() => {
    const d = db.prepare("SELECT d.assessment_id AS aid, d.resolution_assessment_id AS res, a.attempt_id AS attemptId, a.sequence AS seq FROM assessment_disputes d JOIN assessment_revisions a ON a.id = d.assessment_id WHERE d.id = ?").get(input.disputeId) as
      | { aid: string; res: string | null; attemptId: string; seq: number }
      | undefined;
    if (!d) throw new ApiError(404, "DISPUTE_NOT_FOUND", "Unknown dispute");
    if (d.res !== null) throw new ApiError(409, "DISPUTE_RESOLVED", "Dispute already has a resolution");
    const r = db.prepare("SELECT attempt_id AS attemptId, sequence AS seq FROM assessment_revisions WHERE id = ?").get(input.resolutionAssessmentId) as { attemptId: string; seq: number } | undefined;
    // the disputed revision itself is d.seq; the dispute revision is d.seq+1; a resolution must come after both
    if (!r || r.attemptId !== d.attemptId || r.seq <= d.seq + 1) {
      throw new ApiError(422, "INVALID_RESOLUTION", "Resolution must be a later revision of the same attempt");
    }
    db.prepare("UPDATE assessment_disputes SET resolution_assessment_id = ? WHERE id = ? AND resolution_assessment_id IS NULL").run(input.resolutionAssessmentId, input.disputeId);
  }).immediate();
}
