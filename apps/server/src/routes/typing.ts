import type { FastifyInstance } from "fastify";
import type { ZodType } from "zod";
import { z } from "zod";
import {
  TypingAbortRequestSchema,
  TypingAppearancesRequestSchema,
  TypingBookCheckpointRequestSchema,
  TypingBookCompleteRequestSchema,
  TypingRecallSaveRequestSchema,
  TypingWordsCompleteRequestSchema,
} from "@english-lab/contracts";
import type { Db } from "../db/open.js";
import { ApiError } from "../errors.js";
import type { SessionDeps } from "../domain/sessions/policy.js";
import { typingAnalytics } from "../domain/typing/analytics.js";
import { dictationOverview } from "../domain/typing/dictation/lessons.js";
import type { DictationEnv } from "../domain/typing/dictation/lessons.js";
import { recallSave, recallStart } from "../domain/typing/recall.js";
import { abortBook, booksOverview, checkpointBook, completeBook, startBook } from "../domain/typing/books.js";
import { buildTypingResult, sessionRow } from "../domain/typing/result.js";
import { abortWords, completeWords, recordAppearances, startWords, wordsOverview } from "../domain/typing/words.js";

function parse<T>(schema: ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "Request body is invalid", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  return r.data;
}

const idParams = { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 64 } }, required: ["id"] } as const;

const AnalyticsQuery = z.object({ mode: z.enum(["words", "books"]), days: z.enum(["7", "30", "90", "all"]).optional(), timezone: z.string().min(1).max(64).optional() }).strict();

export interface TypingRouteOptions {
  booksDir: string;
  dictation: DictationEnv;
}

export function registerTypingRoutes(app: FastifyInstance, db: Db, deps: SessionDeps, opts: TypingRouteOptions): void {
  app.get("/api/v1/typing/overview", async () => ({ words: wordsOverview(db), books: booksOverview(db, opts.booksDir), dictation: dictationOverview(db, opts.dictation) }));

  app.post("/api/v1/typing/words/start", async (req, reply) => {
    reply.code(201);
    return startWords(db, deps);
  });

  app.post<{ Params: { id: string } }>("/api/v1/typing/words/:id/appearances", { schema: { params: idParams } }, async (req) => {
    const b = parse(TypingAppearancesRequestSchema, req.body);
    return recordAppearances(db, deps, req.params.id, b.appearances);
  });

  app.post<{ Params: { id: string } }>("/api/v1/typing/words/:id/complete", { schema: { params: idParams } }, async (req) => {
    const b = parse(TypingWordsCompleteRequestSchema, req.body);
    return completeWords(db, deps, req.params.id, b);
  });

  app.post<{ Params: { id: string } }>("/api/v1/typing/words/:id/abort", { schema: { params: idParams } }, async (req) => {
    const b = parse(TypingAbortRequestSchema, req.body);
    return abortWords(db, deps, req.params.id, b);
  });

  app.post("/api/v1/typing/books/start", async (req, reply) => {
    reply.code(201);
    return startBook(db, deps, opts.booksDir);
  });

  app.post<{ Params: { id: string } }>("/api/v1/typing/books/:id/checkpoint", { schema: { params: idParams } }, async (req) => {
    const b = parse(TypingBookCheckpointRequestSchema, req.body);
    return checkpointBook(db, req.params.id, b);
  });

  app.post<{ Params: { id: string } }>("/api/v1/typing/books/:id/complete", { schema: { params: idParams } }, async (req) => {
    const b = parse(TypingBookCompleteRequestSchema, req.body);
    return completeBook(db, deps, opts.booksDir, req.params.id, b);
  });

  app.post<{ Params: { id: string } }>("/api/v1/typing/books/:id/abort", { schema: { params: idParams } }, async (req) => {
    const b = parse(TypingAbortRequestSchema, req.body);
    return abortBook(db, deps, req.params.id, b);
  });

  // the memory check after a completed Words level (up to three saved words typed from their translation)
  app.get<{ Params: { id: string } }>("/api/v1/typing/sessions/:id/recall", { schema: { params: idParams } }, async (req) => recallStart(db, deps, req.params.id));
  app.post<{ Params: { id: string } }>("/api/v1/typing/sessions/:id/recall", { schema: { params: idParams } }, async (req) => {
    const b = parse(TypingRecallSaveRequestSchema, req.body);
    return recallSave(db, deps, req.params.id, b.results);
  });

  app.get<{ Params: { id: string } }>("/api/v1/typing/sessions/:id/result", { schema: { params: idParams } }, async (req) => buildTypingResult(db, sessionRow(db, req.params.id)));

  app.get("/api/v1/analytics/typing", async (req) => {
    const q = AnalyticsQuery.safeParse(req.query);
    if (!q.success) throw new ApiError(400, "VALIDATION_ERROR", "Query is invalid");
    const days = !q.data.days || q.data.days === "all" ? null : Number(q.data.days);
    const timezone = q.data.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      new Intl.DateTimeFormat("en-AU", { timeZone: timezone });
    } catch {
      throw new ApiError(422, "TIMEZONE_INVALID", `Unknown time zone ${timezone}`);
    }
    return typingAnalytics(db, { mode: q.data.mode, days, timezone, now: deps.now() });
  });
}
