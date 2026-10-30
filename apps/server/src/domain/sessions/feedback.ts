import type { FeedbackResponse } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { exposeUnits } from "./exposure.js";
import type { SessionDeps } from "./policy.js";
import type { AnalysisV2 } from "../ai/validate.js";

type Payload = Record<string, any>;

function correctAnswer(format: string, content: { payload: Payload }, questionId: string | null): NonNullable<FeedbackResponse["correct"]> {
  const p = content.payload;
  switch (format) {
    case "choose_form":
    case "choose_missing_fragment":
      return { options: (p.options as Array<{ id: string; text: string }>).filter((o) => (p.accepted_option_ids as string[]).includes(o.id)).map((o) => o.text) };
    case "detect_error":
      return p.no_mistake
        ? { noMistake: true }
        : { segments: (p.segments as Array<{ id: string; text: string }>).filter((s) => (p.accepted_segment_ids as string[]).includes(s.id)).map((s) => s.text), corrections: p.corrections as string[] };
    case "context_reading": {
      const q = (p.questions as Array<{ id: string; options: Array<{ id: string; text: string }>; accepted_option_ids: string[] }>).find((x) => x.id === questionId)!;
      return { options: q.options.filter((o) => q.accepted_option_ids.includes(o.id)).map((o) => o.text) };
    }
    default:
      return { answers: p.accepted_answers as string[] };
  }
}

/**
 * Feedback for a slot, delivered only after an answer, a skip or a revealed answer. The accepted-answer sentences are exposed
 * (committed to the global ledger) BEFORE this function returns them. Held-out feedback stays closed. A pending answer is stated
 * as pending - never as wrong - and no model verdict is invented.
 */
export function getFeedback(db: Db, deps: SessionDeps, sessionId: string, slotId: string): FeedbackResponse {
  const f = feedbackCore(db, deps, sessionId, slotId);
  const row = db.prepare("SELECT er.content_json AS c, ss.question_id AS q FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.id = ?").get(slotId) as { c: string; q: string | null };
  const c = JSON.parse(row.c) as { prompt_en: string; payload: Payload };
  const p = c.payload;
  const prompt = p.questions ? ((p.questions as Array<{ id: string; prompt: string }>).find((x) => x.id === row.q)?.prompt ?? null) : p.sentence ?? p.cue_ru ?? c.prompt_en;
  return { ...f, prompt };
}

function feedbackCore(db: Db, deps: SessionDeps, sessionId: string, slotId: string): FeedbackResponse {
  return db
    .transaction((): FeedbackResponse => {
      const slot = db
        .prepare(
          `SELECT ss.id AS slotId, ss.question_id AS questionId, ss.exercise_revision_id AS revisionId, er.type AS format, er.content_json AS content, s.purpose AS purpose, s.status AS sessionStatus
             FROM session_slots ss JOIN sessions s ON s.id = ss.session_id JOIN exercise_revisions er ON er.id = ss.exercise_revision_id
            WHERE ss.id = ? AND ss.session_id = ?`,
        )
        .get(slotId, sessionId) as { slotId: string; questionId: string | null; revisionId: string; format: string; content: string; purpose: string; sessionStatus: string } | undefined;
      if (!slot) throw new ApiError(404, "SLOT_NOT_FOUND", "Slot does not belong to this session");
      const events = (db.prepare("SELECT event_type AS t FROM session_events WHERE slot_id = ?").all(slotId) as Array<{ t: string }>).map((e) => e.t);
      const attempt = db.prepare("SELECT id, idk FROM attempts WHERE slot_id = ? ORDER BY attempt_no DESC LIMIT 1").get(slotId) as { id: string; idk: number } | undefined;
      const answerSeen = events.includes("show_answer");
      const skipped = events.includes("skip");
      if (!attempt && !answerSeen && !skipped) throw new ApiError(409, "FEEDBACK_NOT_AVAILABLE", "Answer, skip or show the answer first");
      // diagnostic blocks and held-out checks give feedback AFTER the block (spec/04, spec/08): per-task feedback would teach the answer to the next task
      if ((slot.purpose === "heldout" || slot.purpose === "diagnostic") && slot.sessionStatus === "active") {
        return { slotId, state: "closed", verdict: null, confirmation: null, explanation_ru: null, correct: null, message: "Feedback opens when the block is finished." };
      }
      const content = JSON.parse(slot.content) as { explanation_ru: string; payload: Payload };

      if (skipped && !attempt && !answerSeen) {
        return { slotId, state: "skipped", verdict: null, confirmation: null, explanation_ru: null, correct: null, message: "Skipped. It stays in your history and is not counted as a mistake." };
      }
      const a = attempt
        ? (db.prepare("SELECT verdict, confirmation FROM assessment_revisions WHERE attempt_id = ? ORDER BY sequence DESC LIMIT 1").get(attempt.id) as { verdict: string; confirmation: string })
        : null;

      // This is a model draft, never a confirmed grade or evidence of task meaning.
      const annotation = attempt && a && ["pending", "ambiguous", "correct", "incorrect"].includes(a.verdict) && a.confirmation !== "confirmed"
        ? (db.prepare("SELECT findings_json AS value FROM ai_annotations WHERE attempt_id = ? AND json_extract(findings_json, '$.superseded') = 0 ORDER BY rowid DESC LIMIT 1").get(attempt.id) as { value: string } | undefined)
        : undefined;
      let aiReview: FeedbackResponse["aiReview"];
      if (annotation) {
        const output = (JSON.parse(annotation.value) as { output: AnalysisV2 }).output;
        if (output?.schema_version === "analysis-v2") aiReview = { judgement: output.judgement, explanation_ru: output.explanation_ru, findings: output.findings.map((f) => ({ original: f.original, suggestion: f.suggestion, explanation_ru: f.explanation_ru })) };
      }

      if (a && (a.verdict === "pending" || a.verdict === "ambiguous")) {
        exposeUnits(db, deps, slotId, slot.revisionId, "answer");
        return {
          slotId,
          state: "pending",
          verdict: a.verdict,
          confirmation: a.confirmation,
          explanation_ru: null,
          ...(aiReview ? { aiReview } : {}),
          correct: correctAnswer(slot.format, content, slot.questionId),
          message: "Saved — AI review after this session. This is not marked wrong. Approved examples are shown for comparison.",
        };
      }
      if (a && a.verdict === "disputed") {
        return { slotId, state: "pending", verdict: a.verdict, confirmation: a.confirmation, explanation_ru: null, correct: null, message: "This assessment is disputed and is being reviewed." };
      }
      if (a && a.confirmation !== "confirmed") {
        return { slotId, state: "pending", verdict: a.verdict, confirmation: a.confirmation, explanation_ru: null, correct: null, ...(aiReview ? { aiReview } : {}), message: "AI suggestion — needs review. It is not confirmed." };
      }

      exposeUnits(db, deps, slotId, slot.revisionId, "answer"); // committed before the answer is returned
      const verdict = a?.verdict ?? null;
      return {
        slotId,
        state: "confirmed",
        verdict,
        confirmation: a?.confirmation ?? null,
        explanation_ru: content.explanation_ru,
        correct: correctAnswer(slot.format, content, slot.questionId),
        message:
          verdict === "correct"
            ? "Correct."
            : verdict === "idk"
              ? "No problem — this is the answer. It counts as a failed first attempt, not as a skip."
              : verdict === "incorrect"
                ? "Not this time. You can try again if you like, or continue."
                : "Here is the answer. Viewing it means later attempts do not count as independent.",
      };
    })
    .immediate();
}
