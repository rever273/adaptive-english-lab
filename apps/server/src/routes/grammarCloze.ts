import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/open.js";
import { ApiError } from "../errors.js";
import { recordClozeActivity } from "../domain/grammarCloze/activity.js";
import { clozeAnalytics } from "../domain/grammarCloze/analytics.js";
import { requestAnalysis, viewOf } from "../domain/grammarCloze/analysis.js";
import { completeSession, excludeItem, markShown, overview, sessionView, startSession, submitAnswer, summary, type Deps } from "../domain/grammarCloze/repository.js";

const idParams = { schema: { params: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 80 } }, required: ["id"] } } } as const;
const id = z.string().min(1).max(80);
const Start = z.object({ tabId: id }).strict();
const Shown = z.object({ position: z.number().int().min(1).max(50) }).strict();
const Answer = z.object({ id: z.string().uuid(), position: z.number().int().min(1).max(50), chosen: z.string().min(1).max(200), responseMs: z.number().min(0).max(3600000).optional() }).strict();
const Exclude = z.object({ sessionId: id.optional(), reason: z.string().max(500).optional() }).strict();
const Analysis = z.object({ sessionId: id, position: z.number().int().min(1).max(50) }).strict();
const Activity = z.object({ id: z.string().uuid(), tabId: id, startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative() }).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new ApiError(400, "VALIDATION_ERROR", "Request is invalid", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

/**
 * Grammar Cloze / Sentence Survival (TASK_032). Everything lives in `grammar_cloze_*` tables: no practice session, no exercise bank, no Mastery.
 */
export function registerGrammarClozeRoutes(app: FastifyInstance, db: Db, deps: Deps, hooks: { onQueued?: () => void } = {}): void {
  app.get("/api/v1/grammar-cloze/overview", async () => overview(db));

  app.post("/api/v1/grammar-cloze/sessions", async (req, reply) => {
    const b = parse(Start, req.body);
    const r = startSession(db, deps, b.tabId);
    return reply.code(r.resumed ? 200 : 201).send({ resumed: r.resumed, session: sessionView(db, r.sessionId) });
  });

  app.get<{ Params: { id: string } }>("/api/v1/grammar-cloze/sessions/:id", idParams, async (req) => sessionView(db, req.params.id));

  app.post<{ Params: { id: string } }>("/api/v1/grammar-cloze/sessions/:id/shown", idParams, async (req) => {
    markShown(db, deps, req.params.id, parse(Shown, req.body).position);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/v1/grammar-cloze/sessions/:id/answers", idParams, async (req) => {
    const b = parse(Answer, req.body);
    return submitAnswer(db, deps, req.params.id, b);
  });

  app.post<{ Params: { id: string } }>("/api/v1/grammar-cloze/items/:id/exclude", idParams, async (req) => {
    const b = parse(Exclude, req.body);
    return excludeItem(db, deps, req.params.id, b);
  });

  app.post<{ Params: { id: string } }>("/api/v1/grammar-cloze/sessions/:id/complete", idParams, async (req) => completeSession(db, deps, req.params.id));
  app.get<{ Params: { id: string } }>("/api/v1/grammar-cloze/sessions/:id/summary", idParams, async (req) => summary(db, req.params.id));

  app.post<{ Params: { id: string } }>("/api/v1/grammar-cloze/sessions/:id/activity", idParams, async (req) => {
    const b = parse(Activity, req.body);
    return recordClozeActivity(db, deps, req.params.id, b);
  });

  app.post<{ Params: { id: string } }>("/api/v1/grammar-cloze/items/:id/analysis", idParams, async (req) => {
    const b = parse(Analysis, req.body);
    const v = requestAnalysis(db, deps, req.params.id, b.sessionId, b.position);
    hooks.onQueued?.();
    return v;
  });
  app.get<{ Params: { id: string } }>("/api/v1/grammar-cloze/analyses/:id", idParams, async (req) => viewOf(db, req.params.id));

  app.get<{ Querystring: { days?: string } }>("/api/v1/grammar-cloze/analytics", async (req) => {
    const days = req.query.days ?? "30";
    if (days !== "7" && days !== "30" && days !== "90" && days !== "all") throw new ApiError(400, "VALIDATION_ERROR", "days must be 7, 30, 90 or all");
    return clozeAnalytics(db, days, deps.now());
  });
}
