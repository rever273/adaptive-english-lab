import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/open.js";
import { ApiError } from "../errors.js";
import type { SttService } from "../domain/stt/sttService.js";
import { recordLessonActivity } from "../domain/wordLessons/activity.js";
import { retryFailed, startGeneration, studioStatus } from "../domain/wordLessons/generate.js";
import { completeRun, disputeAttempt, giveUpWaiting, listLessons, recordEvent, runState, startRun, submitAttempt } from "../domain/wordLessons/runs.js";

const idParams = { schema: { params: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 64 } }, required: ["id"] } } } as const;
const attemptParams = { schema: { params: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 64 }, attemptId: { type: "string", minLength: 1, maxLength: 64 } }, required: ["id", "attemptId"] } } } as const;

const id = z.string().min(1).max(64);
const Generate = z.object({ count: z.number().int().min(1).max(50) }).strict();
const Start = z.object({ tabId: id }).strict();
const Event = z.object({ id: z.string().uuid(), itemKey: id, kind: z.enum(["hint_word", "hint_partial", "hint_full", "translation", "hint_start", "continue", "stage_done"]) }).strict();
const Attempt = z
  .object({ id: z.string().uuid(), itemKey: id, text: z.string().max(2000), input: z.enum(["text", "voice"]), streamId: id.optional(), draftId: id.optional() })
  .strict()
  .refine((b) => b.input === "text" || (b.streamId && b.draftId), { message: "a voice answer needs the stream and the draft" });
const Dispute = z.object({ reason: z.string().max(500).optional() }).strict();
const Activity = z.object({ id: z.string().uuid(), tabId: id, startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative() }).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new ApiError(400, "VALIDATION_ERROR", "Request is invalid", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

/**
 * Single Word Context Practice (TASK_031). Lessons are written ahead of time in Content Studio; here the learner picks a ready lesson and plays it.
 * Everything a run needs is in `word_lesson_*` tables: no practice session, no exercise bank, no Mastery.
 */
export function registerWordLessonRoutes(app: FastifyInstance, db: Db, deps: { now: () => Date; newId: () => string }, hooks: { onQueued?: () => void; stt?: SttService | null } = {}): void {
  const voice = () => Boolean(hooks.stt?.available());
  const state = (runId: string) => runState(db, deps, runId, voice());

  app.get("/api/v1/word-lessons", async () => listLessons(db, deps.now()));
  app.get("/api/v1/word-lessons/studio", async () => studioStatus(db, deps.now()));

  app.post("/api/v1/word-lessons/generate", async (req, reply) => {
    const b = parse(Generate, req.body);
    const r = startGeneration(db, deps, b.count);
    hooks.onQueued?.();
    return reply.code(202).send({ ...r, status: studioStatus(db, deps.now()) });
  });

  app.post("/api/v1/word-lessons/retry-failed", async () => {
    const r = retryFailed(db, deps);
    hooks.onQueued?.();
    return { ...r, status: studioStatus(db, deps.now()) };
  });

  app.post<{ Params: { id: string } }>("/api/v1/word-lessons/:id/runs", idParams, async (req, reply) => {
    const b = parse(Start, req.body);
    const r = startRun(db, deps, req.params.id, b.tabId);
    return reply.code(r.resumed ? 200 : 201).send({ runId: r.runId, resumed: r.resumed, state: state(r.runId) });
  });

  app.get<{ Params: { id: string } }>("/api/v1/word-lesson-runs/:id", idParams, async (req) => state(req.params.id));

  app.post<{ Params: { id: string } }>("/api/v1/word-lesson-runs/:id/events", idParams, async (req) => {
    const b = parse(Event, req.body);
    recordEvent(db, deps, req.params.id, b);
    return state(req.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/v1/word-lesson-runs/:id/attempts", idParams, async (req) => {
    const b = parse(Attempt, req.body);
    // a voice answer: the recognised text comes from the draft the service holds (text only; the audio is already gone)
    let spoken: { asrText: string; sttModelId: string; use: () => void } | undefined;
    if (b.input === "voice") {
      if (!hooks.stt) throw new ApiError(503, "STT_UNAVAILABLE", "Voice is not available. Type your answer instead.");
      const already = db.prepare("SELECT 1 FROM word_lesson_attempts WHERE id = ?").get(b.id);
      if (!already) spoken = hooks.stt.takeDraft(b.streamId!, b.draftId!, req.params.id);
    }
    const r = submitAttempt(db, deps, req.params.id, { id: b.id, itemKey: b.itemKey, text: b.text, input: b.input, ...(spoken ? { voice: { asrText: spoken.asrText, sttModelId: spoken.sttModelId } } : {}) });
    spoken?.use();
    if (r.queued) hooks.onQueued?.();
    return state(req.params.id);
  });

  app.post<{ Params: { id: string; attemptId: string } }>("/api/v1/word-lesson-runs/:id/attempts/:attemptId/dispute", attemptParams, async (req) => {
    const b = parse(Dispute, req.body ?? {});
    disputeAttempt(db, deps, req.params.id, req.params.attemptId, b.reason);
    return state(req.params.id);
  });

  app.post<{ Params: { id: string; attemptId: string } }>("/api/v1/word-lesson-runs/:id/attempts/:attemptId/give-up", attemptParams, async (req) => {
    giveUpWaiting(db, deps, req.params.id, req.params.attemptId);
    return state(req.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/v1/word-lesson-runs/:id/complete", idParams, async (req) => {
    completeRun(db, deps, req.params.id);
    return state(req.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/v1/word-lesson-runs/:id/activity", idParams, async (req) => recordLessonActivity(db, deps, req.params.id, parse(Activity, req.body)));

  app.post<{ Params: { id: string } }>("/api/v1/word-lesson-runs/:id/stt/start", idParams, async (req, reply) => {
    if (!hooks.stt) throw new ApiError(503, "STT_UNAVAILABLE", "Voice is not available. Type your answer instead.");
    const b = parse(Start, req.body);
    const run = db.prepare("SELECT status, tab_id AS tabId FROM word_lesson_runs WHERE id = ?").get(req.params.id) as { status: string; tabId: string } | undefined;
    if (!run) throw new ApiError(404, "WORD_LESSON_RUN_NOT_FOUND", "Unknown lesson run");
    return reply.code(201).send(await hooks.stt.start(req.params.id, b.tabId, "word_lesson"));
  });
}
