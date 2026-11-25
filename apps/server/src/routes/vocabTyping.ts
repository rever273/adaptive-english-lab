import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { VT_WORD_FILTERS, VtActivityRequestSchema, VtCompleteRequestSchema, VtEventRequestSchema, VtFlagRequestSchema, VtReviewRequestSchema, VtStartRequestSchema } from "@english-lab/contracts";
import type { Db } from "../db/open.js";
import { buildAnalytics } from "../domain/vocabTyping/analytics.js";
import { flagCard, recordCheck, recordLearn, startLearning } from "../domain/vocabTyping/learning.js";
import { buildOverview, listWords, restoreWord } from "../domain/vocabTyping/overview.js";
import { completeSession, loadSession, recordActivity, recordScreening, startScreening } from "../domain/vocabTyping/sessions.js";
import { emptyLearningState, sessionState } from "../domain/vocabTyping/view.js";
import { parse } from "./contextLoop.js";

const idParams = { schema: { params: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 64 } }, required: ["id"] } } } as const;
const lemmaParams = { schema: { params: { type: "object", properties: { lemma: { type: "string", pattern: "^[a-z]{2,32}$" } }, required: ["lemma"] } } } as const;
const WordsQuery = z.object({ state: z.enum(VT_WORD_FILTERS).optional(), q: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }).strict();
const AnalyticsQuery = z.object({ days: z.coerce.number().int().min(1).max(3650).default(30) }).strict();

/** Vocabulary Typing (TASK_038): the fourth Typing block. Every route is on localhost like the rest of the app; bodies are strict. */
export function registerVocabTypingRoutes(app: FastifyInstance, db: Db, deps: { now: () => Date; newId: () => string }): void {
  app.get("/api/v1/typing/vocab/overview", async () => buildOverview(db, deps));

  app.post("/api/v1/typing/vocab/screening/start", async (req, reply) => {
    const r = startScreening(db, deps, parse(VtStartRequestSchema, req.body).tabId);
    return reply.code(r.resumed ? 200 : 201).send({ ...r, state: sessionState(db, r.sessionId) });
  });

  // nothing to learn or check right now: 200 with an empty state and no session
  app.post("/api/v1/typing/vocab/learning/start", async (req, reply) => {
    const r = startLearning(db, deps, parse(VtStartRequestSchema, req.body).tabId);
    if (!r) return reply.code(200).send({ sessionId: "", resumed: false, state: emptyLearningState(db, deps) });
    return reply.code(r.resumed ? 200 : 201).send({ ...r, state: sessionState(db, r.sessionId) });
  });

  app.get<{ Params: { id: string } }>("/api/v1/typing/vocab/sessions/:id", idParams, async (req) => sessionState(db, req.params.id));

  app.post<{ Params: { id: string } }>("/api/v1/typing/vocab/sessions/:id/events", idParams, async (req) => {
    const b = parse(VtEventRequestSchema, req.body);
    if (b.kind === "screen_known" || b.kind === "screen_unknown" || b.kind === "screen_archived") recordScreening(db, deps, req.params.id, { clientEventId: b.clientEventId, tabId: b.tabId, lemma: b.lemma!, kind: b.kind, typing: b.typing });
    else recordLearn(db, deps, req.params.id, { clientEventId: b.clientEventId, tabId: b.tabId, cardIndex: b.cardIndex!, kind: b.kind, typing: b.typing });
    return sessionState(db, req.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/v1/typing/vocab/sessions/:id/reviews", idParams, async (req) => {
    const b = parse(VtReviewRequestSchema, req.body);
    recordCheck(db, deps, req.params.id, b);
    return sessionState(db, req.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/v1/typing/vocab/sessions/:id/flag", idParams, async (req) => {
    flagCard(db, deps, req.params.id, parse(VtFlagRequestSchema, req.body));
    return sessionState(db, req.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/v1/typing/vocab/sessions/:id/complete", idParams, async (req) => {
    const b = parse(VtCompleteRequestSchema, req.body);
    loadSession(db, req.params.id);
    completeSession(db, deps, req.params.id, b.tabId, b.keyStats);
    return sessionState(db, req.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/v1/typing/vocab/sessions/:id/activity", idParams, async (req) => recordActivity(db, deps, req.params.id, parse(VtActivityRequestSchema, req.body)));

  app.get("/api/v1/typing/vocab/analytics", async (req) => buildAnalytics(db, deps, parse(AnalyticsQuery, req.query).days));

  app.get("/api/v1/typing/vocab/words", async (req) => {
    const q = parse(WordsQuery, req.query);
    return listWords(db, { ...(q.state ? { filter: q.state } : {}), ...(q.q ? { search: q.q } : {}), limit: q.limit, offset: q.offset });
  });

  app.post<{ Params: { lemma: string } }>("/api/v1/typing/vocab/words/:lemma/restore", lemmaParams, async (req) => {
    restoreWord(db, deps, req.params.lemma);
    return buildOverview(db, deps);
  });
}
