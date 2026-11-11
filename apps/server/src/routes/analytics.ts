import { grammarTrends } from "../domain/analytics/grammarTrends.js";
import type { FastifyInstance } from "fastify";
import { MASTERY_V3 } from "@english-lab/learning";
import { SkillAnalyticsQuerySchema, type SkillAnalyticsResponse } from "@english-lab/contracts";
import type { Db } from "../db/open.js";
import { readRun, runMastery } from "../domain/analytics/runs.js";
import { ApiError } from "../errors.js";

export function registerAnalyticsRoutes(app: FastifyInstance, db: Db, now: () => Date): void {
  /** trends of the classic Grammar Practice for the charts (read-only, derived) */
  app.get<{ Querystring: { days?: string } }>("/api/v1/analytics/grammar-trends", async (req) => {
    const days = req.query.days ?? "30";
    if (days !== "7" && days !== "30" && days !== "90" && days !== "all") throw new ApiError(400, "VALIDATION_ERROR", "days must be 7, 30, 90 or all");
    return grammarTrends(db, days, now());
  });

  // Computes (or reuses) a saved mastery run (v1 confirmed only; v2 with ?provisional=1, D65) and returns it. Derived data only; no raw event is written or changed.
  app.get("/api/v1/analytics/skills", async (req): Promise<SkillAnalyticsResponse> => {
    const parsed = SkillAnalyticsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(400, "VALIDATION_ERROR", "Query is invalid", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    }
    const q = parsed.data;
    const hour = new Date(now());
    hour.setUTCMinutes(0, 0, 0);
    const run = runMastery(db, { asOf: q.asOf ?? hour.toISOString(), watermark: q.watermark, cohort: { criterionVersion: q.criterionVersion, difficulty: q.difficulty }, now, ...(q.provisional === "1" ? { config: MASTERY_V3 } : {}) });
    return {
      run: { id: run.id, algorithmId: run.algorithmId, asOf: run.asOf, eventWatermark: run.eventWatermark, inputHash: run.inputHash, cohort: run.cohort, reused: !run.created },
      skills: readRun(db, run.id) as SkillAnalyticsResponse["skills"],
    };
  });
}
