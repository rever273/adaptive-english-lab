import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { ZodType } from "zod";
import { z } from "zod";
import { DictationAnswerRequestSchema, DictationPrepareRequestSchema, DictationHintRequestSchema, DictationPlayRequestSchema, DictationTimeRequestSchema, SoundFlagRequestSchema } from "@english-lab/contracts";
import type { Db } from "../db/open.js";
import { ApiError } from "../errors.js";
import { dictationAnalytics } from "../domain/typing/dictation/analytics.js";
import { createLesson, dictationState, exerciseAudio, openTranslation, prepareTracks, recordPlay, recordTime, requestHint, retryLesson, revealAnswer, startLesson, submitAnswer, type DictationEnv, type Deps } from "../domain/typing/dictation/lessons.js";
import { modelShaOpt } from "../domain/voices/model.js";
import { buildDictationResult } from "../domain/typing/dictation/result.js";

function parse<T>(schema: ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new ApiError(400, "VALIDATION_ERROR", "Request body is invalid", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

const idParams = { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 64 } }, required: ["id"] } as const;
const Empty = z.object({}).strict();
const AnalyticsQuery = z.object({ days: z.enum(["7", "30", "90", "all"]).optional(), timezone: z.string().min(1).max(64).optional() }).strict();

export interface TypingDictationRouteOptions {
  env: DictationEnv;
  /** called after a lesson has been queued so the dispatcher starts at once */
  onQueued?: () => void;
}

/** Audio Dictation (TASK_028). Mutations run in their own transactions inside the domain functions. */
export function registerTypingDictationRoutes(app: FastifyInstance, db: Db, deps: Deps, opts: TypingDictationRouteOptions): void {
  const base = "/api/v1/typing/dictation";
  const { env } = opts;

  app.post(`${base}/lessons`, async (req, reply) => {
    parse(Empty, req.body ?? {});
    const lesson = createLesson(db, deps, env);
    opts.onQueued?.();
    reply.code(201);
    return lesson;
  });

  app.post<{ Params: { id: string } }>(`${base}/lessons/:id/retry`, { schema: { params: idParams } }, async (req) => {
    parse(Empty, req.body ?? {});
    const lesson = retryLesson(db, deps, env, req.params.id);
    opts.onQueued?.();
    return lesson;
  });

  app.post<{ Params: { id: string } }>(`${base}/lessons/:id/start`, { schema: { params: idParams } }, async (req) => {
    parse(Empty, req.body ?? {});
    try {
      return startLesson(db, deps, env, req.params.id);
    } finally {
      opts.onQueued?.();
    }
  });

  app.get<{ Params: { id: string } }>(`${base}/lessons/:id/state`, { schema: { params: idParams } }, async (req) => dictationState(db, req.params.id));

  app.post<{ Params: { id: string } }>(`${base}/lessons/:id/time`, { schema: { params: idParams } }, async (req) => {
    const b = parse(DictationTimeRequestSchema, req.body);
    return recordTime(db, req.params.id, b.activeMs);
  });

  app.get<{ Params: { id: string } }>(`${base}/exercises/:id/audio`, { schema: { params: idParams } }, async (req, reply) => {
    const { file } = exerciseAudio(db, env, req.params.id);
    reply.header("content-type", "audio/wav").header("cache-control", "private, max-age=3600");
    return reply.send(createReadStream(file));
  });

  app.post<{ Params: { id: string } }>(`${base}/exercises/:id/play`, { schema: { params: idParams } }, async (req) => {
    const b = parse(DictationPlayRequestSchema, req.body);
    return recordPlay(db, deps, req.params.id, b.source);
  });

  // D128: "Sounds bad" mark on the sound of a voiced sentence; changes nothing about the answer, XP or Mastery
  app.post<{ Params: { id: string } }>(`${base}/exercises/:id/sound-flag`, { schema: { params: idParams } }, async (req) => {
    const b = parse(SoundFlagRequestSchema, req.body);
    return env.voices.setFlag(db, { exerciseId: req.params.id, flagged: b.flagged });
  });

  app.post<{ Params: { id: string } }>(`${base}/exercises/:id/hint`, { schema: { params: idParams } }, async (req) => {
    const b = parse(DictationHintRequestSchema, req.body);
    return requestHint(db, deps, req.params.id, b.typedText);
  });

  app.post<{ Params: { id: string } }>(`${base}/exercises/:id/reveal`, { schema: { params: idParams } }, async (req) => {
    parse(Empty, req.body ?? {});
    return revealAnswer(db, deps, req.params.id);
  });

  // what the prepared tracks look like in total; sentences are never listed, so a lesson is not spoiled
  app.get(`${base}/pool`, async () => {
    const unused = "NOT EXISTS (SELECT 1 FROM typing_dictation_pool_use u WHERE u.pool_id = p.id)";
    const total = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(audio_ms), 0) AS ms, COALESCE(MIN(word_count), 0) AS minWords, COALESCE(MAX(word_count), 0) AS maxWords, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM typing_dictation_pool p WHERE ${unused}`).get() as { n: number; ms: number; minWords: number; maxWords: number; oldest: string | null; newest: string | null };
    const topics = db.prepare(`SELECT topic, COUNT(*) AS n FROM typing_dictation_pool p WHERE ${unused} GROUP BY topic ORDER BY n DESC, topic LIMIT 12`).all() as Array<{ topic: string; n: number }>;
    const voices = db.prepare(`SELECT voice_name AS name, COUNT(*) AS n FROM typing_dictation_pool p WHERE ${unused} GROUP BY voice_name ORDER BY n DESC, voice_name`).all() as Array<{ name: string; n: number }>;
    const used = (db.prepare("SELECT COUNT(*) AS n FROM typing_dictation_pool_use").get() as { n: number }).n;
    return { ready: total.n, used, audioSeconds: Math.round(total.ms / 1000), minWords: total.minWords, maxWords: total.maxWords, oldest: total.oldest, newest: total.newest, topics, voices };
  });

  // tracks made ahead of time, so the next lessons start at once
  app.post(`${base}/pool`, async (req, reply) => {
    const b = parse(DictationPrepareRequestSchema, req.body);
    const r = prepareTracks(db, deps, env, b.count);
    opts.onQueued?.();
    reply.code(201);
    return r;
  });

  app.post<{ Params: { id: string } }>(`${base}/exercises/:id/translation`, { schema: { params: idParams } }, async (req) => {
    parse(Empty, req.body ?? {});
    return openTranslation(db, deps, req.params.id);
  });

  app.post<{ Params: { id: string } }>(`${base}/exercises/:id/answer`, { schema: { params: idParams } }, async (req) => {
    const b = parse(DictationAnswerRequestSchema, req.body);
    return submitAnswer(db, deps, req.params.id, b);
  });

  app.get<{ Params: { id: string } }>(`${base}/lessons/:id/result`, { schema: { params: idParams } }, async (req) => buildDictationResult(db, req.params.id));

  app.get("/api/v1/analytics/typing/dictation", async (req) => {
    const q = AnalyticsQuery.safeParse(req.query);
    if (!q.success) throw new ApiError(400, "VALIDATION_ERROR", "Query is invalid");
    const days = !q.data.days || q.data.days === "all" ? null : Number(q.data.days);
    const timezone = q.data.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      new Intl.DateTimeFormat("en-AU", { timeZone: timezone });
    } catch {
      throw new ApiError(422, "TIMEZONE_INVALID", `Unknown time zone ${timezone}`);
    }
    return dictationAnalytics(db, { days, timezone, now: deps.now(), voices: env.voices.list(db, { purpose: "dictation", ...modelShaOpt(env.tts) }) });
  });
}
