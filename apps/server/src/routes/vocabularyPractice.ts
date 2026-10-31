import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/open.js";
import { ApiError } from "../errors.js";
import type { SessionDeps } from "../domain/sessions/policy.js";
import { vocabularyAnalytics } from "../domain/vocabulary/analytics.js";
import { createVocabularySession, vocabularyCoverage, vocabularyPracticeStatus } from "../domain/vocabulary/practice.js";

const CreateBody = z.object({ timezone: z.string().min(1).max(64), count: z.number().int().min(1).max(10).optional(), seed: z.string().max(64).optional() }).strict();
const AnalyticsQuery = z.object({ days: z.enum(["7", "30", "90", "all"]).optional(), timezone: z.string().min(1).max(64).optional() }).strict();

/**
 * Vocabulary Practice (vocabulary TZ): status for the Vocabulary page, creating a vocabulary-only session (it then runs through the ordinary
 * /sessions endpoints: lease, reveal, attempts, events, feedback, finish), Content Studio coverage and Vocabulary Analytics.
 */
export function registerVocabularyPracticeRoutes(app: FastifyInstance, db: Db, deps: SessionDeps): void {
  app.get("/api/v1/vocabulary/practice", async () => vocabularyPracticeStatus(db, deps.now()));

  app.post("/api/v1/vocabulary/sessions", async (req, reply) => {
    const b = CreateBody.safeParse(req.body);
    if (!b.success) throw new ApiError(400, "VALIDATION_ERROR", "Request is invalid", b.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    reply.code(201);
    return createVocabularySession(db, deps, b.data);
  });

  app.get("/api/v1/vocabulary/coverage", async () => vocabularyCoverage(db, deps.now()));

  app.get("/api/v1/analytics/vocabulary", async (req) => {
    const q = AnalyticsQuery.safeParse(req.query);
    if (!q.success) throw new ApiError(400, "VALIDATION_ERROR", "Query is invalid");
    const days = !q.data.days || q.data.days === "all" ? null : Number(q.data.days);
    const timezone = q.data.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      new Intl.DateTimeFormat("en-AU", { timeZone: timezone });
    } catch {
      throw new ApiError(422, "TIMEZONE_INVALID", `Unknown time zone ${timezone}`);
    }
    return vocabularyAnalytics(db, { days, now: deps.now(), timezone });
  });
}
