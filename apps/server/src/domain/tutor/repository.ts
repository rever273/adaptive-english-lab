import { z } from "zod";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { enqueue } from "../../queue/jobs.js";
import { getFeedback } from "../sessions/feedback.js";
import type { SessionDeps } from "../sessions/policy.js";

export const TUTOR_PROMPT = "tutor-v1";
export const MAX_QUESTION = 2000;

export const AskSchema = z
  .object({
    sessionId: z.string().min(1).max(64),
    slotId: z.string().min(1).max(64),
    kind: z.enum(["why", "explain_ru", "more_examples", "question"]),
    question: z.string().max(MAX_QUESTION).optional(),
  })
  .strict()
  .refine((b) => b.kind !== "question" || (b.question ?? "").trim().length > 0, { message: "question is required for kind=question", path: ["question"] });

export interface TutorMessage {
  id: string;
  role: "user" | "assistant";
  kind: string;
  source: "user" | "approved_exercise" | "model";
  status: string;
  text: string;
  examples: string[];
  uncertaintyNoteRu: string | null;
  createdAt: string;
  jobId: string | null;
}

/** Skills and ids of the slot's exercise: the ONLY context the tutor ever gets (spec/06 "bounded retrieval"). */
function slotContext(db: Db, slotId: string) {
  const r = db
    .prepare("SELECT ss.exercise_revision_id AS revisionId, ss.question_id AS questionId, er.content_hash AS hash, er.content_json AS c FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.id = ?")
    .get(slotId) as { revisionId: string; questionId: string | null; hash: string; c: string } | undefined;
  if (!r) throw new ApiError(404, "SLOT_NOT_FOUND", "Unknown slot");
  const c = JSON.parse(r.c) as { target_skill?: string; additional_skills?: string[] };
  return { revisionId: r.revisionId, questionId: r.questionId, contentHash: r.hash, skills: [c.target_skill, ...(c.additional_skills ?? [])].filter((x): x is string => Boolean(x)) };
}

type Row = { id: string; role: "user" | "assistant"; kind: string; source: TutorMessage["source"]; status: string; text: string; context_json: string; job_id: string | null; created_at: string };

function rowToMessage(r: Row): TutorMessage {
  const ctx = JSON.parse(r.context_json) as { examples_en?: string[]; uncertainty_note?: string };
  return { id: r.id, role: r.role, kind: r.kind, source: r.source, status: r.status, text: r.text, examples: ctx.examples_en ?? [], uncertaintyNoteRu: ctx.uncertainty_note || null, createdAt: r.created_at, jobId: r.job_id };
}

export function getThread(db: Db, slotId: string): { slotId: string; messages: TutorMessage[]; pendingJobs: number; pendingKinds: string[] } {
  const rows = db.prepare("SELECT id, role, kind, source, status, text, context_json, job_id, created_at FROM tutor_messages WHERE thread_id = ? ORDER BY created_at, rowid").all(slotId) as Row[];
  const pending = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'tutor' AND idempotency_key LIKE ? AND state IN ('queued','waiting_for_gpu','running','paused')").get(`tutor:${slotId}:%`) as { n: number };
  const kinds = db.prepare("SELECT DISTINCT json_extract(payload_json, '$.kind') AS k FROM jobs WHERE kind = 'tutor' AND idempotency_key LIKE ? AND state IN ('queued','waiting_for_gpu','running','paused')").all(`tutor:${slotId}:%`) as Array<{ k: string }>;
  return { slotId, messages: rows.map(rowToMessage), pendingJobs: pending.n, pendingKinds: kinds.map((r) => r.k) };
}

/**
 * Ask the tutor about a slot you have already answered / skipped / seen (the same gate as feedback; diagnostic and held-out blocks stay closed until the
 * block ends, so the tutor can never leak an answer). The APPROVED rule of the exercise is shown immediately and needs no model. "More examples" and free
 * questions are queued for the local model through the single dispatcher; while a Practice lease is active the scheduler does not start them.
 */
export function askTutor(db: Db, deps: SessionDeps, raw: unknown): { threadId: string; jobId: string | null; messages: TutorMessage[] } {
  const parsed = AskSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "Request is invalid", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const b = parsed.data;
  const feedback = getFeedback(db, deps, b.sessionId, b.slotId); // 404/409 for a slot that does not belong here or has not been answered yet
  if (!feedback.explanation_ru) throw new ApiError(409, "TUTOR_NOT_AVAILABLE", "The explanation for this task opens after the answer is confirmed (and after the block for diagnostic checks).");
  const ctx = slotContext(db, b.slotId);
  // D64: "Why?" is the approved rule (instant); "Explain in Russian" is a longer step-by-step explanation written by the local AI
  const needsModel = b.kind === "more_examples" || b.kind === "question" || b.kind === "explain_ru";
  // the same request is not queued twice: a second press while the first is waiting returns the thread as it is
  if (needsModel && b.kind !== "question") {
    const waiting = db.prepare("SELECT id FROM jobs WHERE kind = 'tutor' AND idempotency_key LIKE ? AND json_extract(payload_json, '$.kind') = ? AND state IN ('queued','waiting_for_gpu','running','paused') LIMIT 1").get(`tutor:${b.slotId}:%`, b.kind) as { id: string } | undefined;
    if (waiting) return { threadId: b.slotId, jobId: waiting.id, messages: getThread(db, b.slotId).messages };
  }
  const now = deps.now().toISOString();
  const context = { sessionId: b.sessionId, revisionId: ctx.revisionId, contentHash: ctx.contentHash, questionId: ctx.questionId, skills: ctx.skills };
  const insert = db.prepare("INSERT INTO tutor_messages(id, thread_id, role, kind, source, text, context_json, job_id, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  return db
    .transaction(() => {
      const userId = deps.newId();
      const label = { why: "Why?", explain_ru: "Explain in Russian", more_examples: "More examples", question: (b.question ?? "").trim() }[b.kind];
      insert.run(userId, b.slotId, "user", b.kind, "user", label, JSON.stringify(context), null, "validated", now);
      // the approved rule is shown once per thread for model-bound questions (it is already on screen); "Why?" always repeats it
      const ruleShown = needsModel && db.prepare("SELECT 1 FROM tutor_messages WHERE thread_id = ? AND source = 'approved_exercise' LIMIT 1").get(b.slotId) !== undefined;
      if (!ruleShown) insert.run(deps.newId(), b.slotId, "assistant", b.kind, "approved_exercise", feedback.explanation_ru, JSON.stringify({ ...context, note: "the approved rule of this exercise revision" }), null, "approved", now);
      let jobId: string | null = null;
      if (needsModel) {
        const j = enqueue(db, { now: deps.now, newId: deps.newId }, { kind: "tutor", payload: { messageId: userId, slotId: b.slotId, kind: b.kind, question: b.kind === "question" ? (b.question ?? "").trim() : null }, idempotencyKey: `tutor:${b.slotId}:${userId}`, priority: 2 });
        jobId = j.job.id;
      }
      return { threadId: b.slotId, jobId, messages: getThread(db, b.slotId).messages };
    })
    .immediate();
}
