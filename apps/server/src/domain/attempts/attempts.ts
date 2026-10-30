import type { AttemptRequest, AttemptResponse } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { isAssisted, localDateIn, rawAnswerJson, sameSubmission, toRawAnswer, type StoredSubmission } from "./canonical.js";
import { latestAssessment, writeAssessmentRevision, type AssessmentRow, type AttemptRow } from "./assessments.js";
import { loadSlotContext, type SlotContext } from "./context.js";
import type { AttemptDeps } from "./ports.js";

export interface RecordedAttempt {
  /** 201 for a new attempt, 200 for an idempotent replay of the same submission. */
  status: 200 | 201;
  body: AttemptResponse;
}

function feedbackFor(purpose: SlotContext["purpose"], a: Pick<AssessmentRow, "verdict" | "confirmation">): AttemptResponse["feedback"] {
  if (a.verdict === "pending" || a.verdict === "ambiguous") return { allowed: false, reason: "assessment_pending" };
  if (a.confirmation !== "confirmed") return { allowed: false, reason: "not_confirmed" };
  if (purpose === "heldout" || purpose === "diagnostic") return { allowed: false, reason: "heldout_block_open" }; // spec/04: closed until the block ends
  return { allowed: true, reason: null };
}

function toResponse(
  ctx: SlotContext,
  attempt: Pick<AttemptRow, "id" | "attempt_no" | "first_attempt" | "hints_before" | "answer_seen_before">,
  a: AssessmentRow,
  replayed: boolean,
): AttemptResponse {
  return {
    attemptId: attempt.id,
    attemptNo: attempt.attempt_no,
    firstAttempt: attempt.first_attempt === 1,
    assisted: isAssisted({ hintsBefore: attempt.hints_before, answerSeenBefore: attempt.answer_seen_before === 1 }),
    replayed,
    assessment: {
      id: a.id,
      sequence: a.sequence,
      verdict: a.verdict as AttemptResponse["assessment"]["verdict"],
      confirmation: a.confirmation,
      status: a.verdict === "pending" ? "pending" : "assessed",
    },
    feedback: feedbackFor(ctx.purpose, a),
  };
}

/**
 * Atomic append of one raw attempt + its first assessment revision + evidence rows + outbox descriptor, serialised by
 * BEGIN IMMEDIATE. The server alone decides attempt number, first-attempt, hints/answer-seen and latency; the client
 * cannot claim unaided evidence. Nothing here calls a model or the GPU.
 */
export function recordAttempt(db: Db, deps: AttemptDeps, req: AttemptRequest): RecordedAttempt {
  return db
    .transaction((): RecordedAttempt => {
      const existing = db.prepare("SELECT * FROM attempts WHERE submission_id = ?").get(req.submissionId) as
        | (AttemptRow & StoredSubmission)
        | undefined;
      if (existing) {
        if (!sameSubmission(existing, req)) {
          throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "submissionId was already used with a different payload");
        }
        const ctx = loadSlotContext(db, existing.slot_id);
        const first = db.prepare("SELECT * FROM assessment_revisions WHERE attempt_id = ? AND sequence = 1").get(existing.id) as AssessmentRow;
        return { status: 200, body: toResponse(ctx, existing, first, true) };
      }

      const ctx = loadSlotContext(db, req.slotId);
      if (ctx.sessionStatus !== "active") throw new ApiError(409, "SESSION_NOT_ACTIVE", "Session is not active");

      const events = db.prepare("SELECT event_type AS t, server_at AS at FROM session_events WHERE slot_id = ? ORDER BY server_at, rowid").all(ctx.slotId) as Array<{ t: string; at: string }>;
      const reveal = events.find((e) => e.t === "reveal");
      if (!reveal) throw new ApiError(409, "SLOT_NOT_REVEALED", "The slot has not been revealed yet");
      if (events.some((e) => e.t === "skip" || e.t === "continue")) throw new ApiError(409, "SLOT_CLOSED", "The slot was already skipped or continued");
      const hintsBefore = events.filter((e) => e.t === "hint").length;
      const answerSeenBefore = events.some((e) => e.t === "show_answer");

      let rawText: string | null = null;
      if (req.inputMode === "voice") {
        const t = db.prepare("SELECT slot_id, submitted_text FROM transcripts WHERE id = ?").get(req.transcriptId!) as { slot_id: string; submitted_text: string | null } | undefined;
        if (!t || t.slot_id !== ctx.slotId) throw new ApiError(422, "TRANSCRIPT_MISMATCH", "Transcript does not belong to this slot");
        rawText = t.submitted_text;
        if (rawText === null || rawText !== req.answer) {
          throw new ApiError(422, "TRANSCRIPT_MISMATCH", "Submitted text must equal the confirmed transcript text");
        }
      }

      const last = db.prepare("SELECT COALESCE(MAX(attempt_no), 0) AS n FROM attempts WHERE slot_id = ?").get(ctx.slotId) as { n: number };
      const attemptNo = last.n + 1;
      const now = deps.now();
      const row: AttemptRow = {
        id: deps.newId(),
        slot_id: ctx.slotId,
        attempt_no: attemptNo,
        first_attempt: attemptNo === 1 ? 1 : 0,
        hints_before: hintsBefore,
        answer_seen_before: answerSeenBefore ? 1 : 0,
        idk: req.idk === true ? 1 : 0,
        criterion_version: ctx.rubricVersion,
      };
      const raw = toRawAnswer(req);
      db.prepare(
        `INSERT INTO attempts(id, slot_id, submission_id, attempt_no, first_attempt, raw_answer_json, input_mode, transcript_id,
                              hints_before, answer_seen_before, idk, submitted_at, local_date, timezone, latency_ms, criterion_version)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        row.id,
        row.slot_id,
        req.submissionId,
        row.attempt_no,
        row.first_attempt,
        rawAnswerJson(raw),
        req.inputMode,
        req.transcriptId ?? null,
        row.hints_before,
        row.answer_seen_before,
        row.idk,
        now.toISOString(),
        localDateIn(ctx.timezone, now),
        ctx.timezone,
        Math.max(0, now.getTime() - Date.parse(reveal.at)),
        row.criterion_version,
      );

      const decision = deps.assessor.assess({
        attemptId: row.id,
        slotId: ctx.slotId,
        sessionId: ctx.sessionId,
        purpose: ctx.purpose,
        exerciseRevisionId: ctx.exerciseRevisionId,
        exerciseType: ctx.exerciseType,
        content: JSON.parse(ctx.contentJson),
        questionId: ctx.questionId,
        rawAnswer: raw,
        inputMode: req.inputMode,
        idk: req.idk === true,
        firstAttempt: row.first_attempt === 1,
        hintsBefore,
        answerSeenBefore,
        criterionVersion: ctx.rubricVersion,
      });
      const assessment = writeAssessmentRevision(db, deps, ctx, row, decision, latestAssessment(db, row.id));
      if (decision.outbox) deps.outbox.enqueue(db, { ...decision.outbox, attemptId: row.id, assessmentId: assessment.id });

      return { status: 201, body: toResponse(ctx, row, assessment, false) };
    })
    .immediate();
}
