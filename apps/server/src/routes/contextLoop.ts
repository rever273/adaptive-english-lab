import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CONTEXT_LOOP_PER_WORD } from "@english-lab/contracts";
import type { Db } from "../db/open.js";
import { ApiError } from "../errors.js";
import type { SttService } from "../domain/stt/sttService.js";
import { cancelAgentBatch, completeAgentBatch, startAgentBatch, startGeneration, studioStatus } from "../domain/contextLoop/generate.js";
import { editByLearner, loadSentences, setStatusByLearner, viewOf } from "../domain/contextLoop/sentences.js";
import { answerCard, answerCheck, checkFirstLetter, completeSession, contextLoopStatus, recordActivity, sessionState, startSession } from "../domain/contextLoop/sessions.js";

const id = z.string().min(1).max(64);
const idParams = { schema: { params: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 64 } }, required: ["id"] } } } as const;
const Generate = z.object({ words: z.number().int().min(1).max(30), perWord: z.number().int().min(CONTEXT_LOOP_PER_WORD.min).max(CONTEXT_LOOP_PER_WORD.max) }).strict();
const Start = z.object({ tabId: id }).strict();
const Aids = z.object({ wordAudio: z.boolean().optional(), sentenceAudio: z.boolean().optional(), translation: z.boolean().optional() }).strict();
const Answer = z.object({ id: z.string().uuid(), tabId: id, cardIndex: z.number().int().min(0).max(1000), outcome: z.enum(["recalled", "not_recalled"]), aids: Aids }).strict();
const Check = z
  .object({ id: z.string().uuid(), tabId: id, cardIndex: z.number().int().min(0).max(1000), text: z.string().max(80).nullable(), firstLetter: z.boolean(), input: z.enum(["text", "voice"]).optional(), streamId: id.optional(), draftId: id.optional() })
  .strict()
  .refine((b) => b.input !== "voice" || (b.streamId && b.draftId), { message: "a voice answer needs the stream and the draft" });
const Hint = z.object({ tabId: id, cardIndex: z.number().int().min(0).max(1000) }).strict();
const Activity = z.object({ id: z.string().uuid(), tabId: id, startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative() }).strict();
const Status = z.object({ status: z.enum(["validated", "rejected"]) }).strict();
const Edit = z.object({ text: z.string().trim().min(1).max(200) }).strict();
const Candidate = z.object({ target_id: z.string().max(10), text: z.string().max(300), target_surface: z.string().max(80), context_label: z.string().max(60), difficulty: z.string().max(20), translation_ru: z.string().max(400).optional(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const Complete = z
  .object({
    author: z.string().max(100),
    candidates: z.array(Candidate).max(450),
    review: z.object({ reviewer: z.string().max(100), items: z.array(z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), verdict: z.enum(["accept", "flag", "reject"]), reason: z.string().max(300).optional() }).strict()).max(450) }).strict(),
  })
  .strict();

export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new ApiError(400, "VALIDATION_ERROR", "Request is invalid", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

/** Context Loop (TASK_037): Content Studio part. Sentences are written ahead of time, by the local model (a queued job) or by a coding agent (D161). */
export function registerContextLoopRoutes(app: FastifyInstance, db: Db, deps: { now: () => Date; newId: () => string }, hooks: { onQueued?: () => void; stt?: SttService | null } = {}): void {
  const voice = () => Boolean(hooks.stt?.available());
  app.get("/api/v1/context-loop/studio", async () => studioStatus(db, deps));

  app.post("/api/v1/context-loop/generate", async (req, reply) => {
    const r = startGeneration(db, deps, parse(Generate, req.body));
    hooks.onQueued?.();
    return reply.code(202).send({ batchId: r.batch.id, created: r.created, status: studioStatus(db, deps) });
  });

  app.post("/api/v1/context-loop/agent-batches", async (req, reply) => reply.code(201).send({ ...startAgentBatch(db, deps, parse(Generate, req.body)), status: studioStatus(db, deps) }));

  app.post<{ Params: { id: string } }>("/api/v1/context-loop/agent-batches/:id/complete", idParams, async (req) => completeAgentBatch(db, deps, req.params.id, parse(Complete, req.body)));

  app.post<{ Params: { id: string } }>("/api/v1/context-loop/agent-batches/:id/cancel", idParams, async (req) => {
    cancelAgentBatch(db, deps, req.params.id);
    return studioStatus(db, deps);
  });

  app.get<{ Querystring: { entryId?: string; status?: string } }>("/api/v1/context-loop/sentences", async (req) => {
    const entryId = req.query.entryId ? id.parse(req.query.entryId) : undefined;
    const status = req.query.status;
    return { sentences: loadSentences(db, entryId ? { entryId } : {}).filter((s) => !status || s.status === status).map(viewOf) };
  });

  app.post<{ Params: { id: string } }>("/api/v1/context-loop/sentences/:id/status", idParams, async (req) => setStatusByLearner(db, deps, req.params.id, parse(Status, req.body).status));

  app.post<{ Params: { id: string } }>("/api/v1/context-loop/sentences/:id/edit", idParams, async (req) => editByLearner(db, deps, req.params.id, parse(Edit, req.body).text));

  // ---- practice sessions (§5.3)
  app.get("/api/v1/context-loop/status", async () => contextLoopStatus(db));

  app.post("/api/v1/context-loop/sessions", async (req, reply) => {
    const r = startSession(db, deps, parse(Start, req.body).tabId);
    return reply.code(r.resumed ? 200 : 201).send({ ...r, state: sessionState(db, r.sessionId, voice()) });
  });

  app.get<{ Params: { id: string } }>("/api/v1/context-loop/sessions/:id", idParams, async (req) => sessionState(db, req.params.id, voice()));

  app.post<{ Params: { id: string } }>("/api/v1/context-loop/sessions/:id/answers", idParams, async (req) => {
    answerCard(db, deps, req.params.id, parse(Answer, req.body));
    return sessionState(db, req.params.id, voice());
  });

  // ---- the rare typed/spoken check (D159)
  app.post<{ Params: { id: string } }>("/api/v1/context-loop/sessions/:id/checks", idParams, async (req) => {
    const b = parse(Check, req.body);
    // a spoken answer: the recognised text comes from the draft the speech service holds (text only; the audio is already gone)
    let spoken: { asrText: string; sttModelId: string; use: () => void } | undefined;
    if (b.input === "voice" && b.text !== null) {
      if (!hooks.stt) throw new ApiError(503, "STT_UNAVAILABLE", "Voice is not available. Type your answer instead.");
      if (!db.prepare("SELECT 1 FROM context_loop_attempts WHERE id = ?").get(b.id)) spoken = hooks.stt.takeDraft(b.streamId!, b.draftId!, req.params.id, "context_loop");
    }
    answerCheck(db, deps, req.params.id, { id: b.id, tabId: b.tabId, cardIndex: b.cardIndex, text: b.text, firstLetter: b.firstLetter, ...(spoken ? { voice: { asrText: spoken.asrText, sttModelId: spoken.sttModelId } } : {}) });
    spoken?.use();
    return sessionState(db, req.params.id, voice());
  });

  app.post<{ Params: { id: string } }>("/api/v1/context-loop/sessions/:id/first-letter", idParams, async (req) => {
    const b = parse(Hint, req.body);
    return checkFirstLetter(db, deps, req.params.id, b.tabId, b.cardIndex);
  });

  app.post<{ Params: { id: string } }>("/api/v1/context-loop/sessions/:id/stt/start", idParams, async (req, reply) => {
    if (!hooks.stt) throw new ApiError(503, "STT_UNAVAILABLE", "Voice is not available. Type your answer instead.");
    return reply.code(201).send(await hooks.stt.start(req.params.id, parse(Start, req.body).tabId, "context_loop"));
  });

  app.post<{ Params: { id: string } }>("/api/v1/context-loop/sessions/:id/complete", idParams, async (req) => {
    completeSession(db, deps, req.params.id);
    return sessionState(db, req.params.id, voice());
  });

  app.post<{ Params: { id: string } }>("/api/v1/context-loop/sessions/:id/activity", idParams, async (req) => recordActivity(db, deps, req.params.id, parse(Activity, req.body)));
}
