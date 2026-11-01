import { z } from "zod";

export const CohortSchema = z.object({ criterionVersion: z.string().min(1).max(100), difficulty: z.enum(["A2", "B1", "B2", "C1", "C2"]) }).strict();

/** GET /api/v1/analytics/skills query. `asOf` defaults to now (truncated to the UTC hour so identical requests reuse one run). */
export const SkillAnalyticsQuerySchema = z
  .object({
    criterionVersion: z.string().min(1).max(100),
    difficulty: z.enum(["A2", "B1", "B2", "C1", "C2"]),
    asOf: z.string().datetime().optional(),
    watermark: z.coerce.number().int().min(0).optional(),
    /** D65: "1" = mastery-v2, which also counts AI-checked (never confirmed) verdicts at a lower weight; absent = mastery-v1 (confirmed only) */
    provisional: z.enum(["0", "1"]).optional(),
  })
  .strict();
export type SkillAnalyticsQuery = z.infer<typeof SkillAnalyticsQuerySchema>;

const Status = z.enum(["unknown", "insufficient", "developing", "stale", "stable"]);

export const DimensionComponentsSchema = z
  .object({
    score: z.number().nullable(),
    display: z.number().nullable(),
    a: z.number().nullable(),
    h: z.number().nullable(),
    hSource: z.enum(["independent_check", "no_independent_check"]).nullable(),
    n: z.number().int(),
    days: z.number().int(),
    nEff: z.number().nullable(),
    heldoutN: z.number().int(),
    heldoutDays: z.number().int(),
    delayedSuccessDays: z.number().int(),
    successes: z.number().int(),
    tE: z.string().nullable(),
    lastSeen: z.string().nullable(),
    asOf: z.string(),
    wilson: z.object({ low: z.number(), high: z.number() }).nullable(),
    status: Status,
    label: z.string(),
  })
  .passthrough();

export const SkillAnalyticsResponseSchema = z
  .object({
    run: z
      .object({
        id: z.string(),
        algorithmId: z.string(),
        asOf: z.string(),
        eventWatermark: z.number().int(),
        inputHash: z.string(),
        cohort: CohortSchema,
        reused: z.boolean(),
      })
      .strict(),
    skills: z.array(
      z
        .object({
          skillId: z.string(),
          dimensions: z.object({ recognition: DimensionComponentsSchema.optional(), correction: DimensionComponentsSchema.optional(), production: DimensionComponentsSchema.optional() }),
          summary: z.object({ score: z.number().nullable(), display: z.number().nullable(), reason: z.enum(["ok", "insufficient_dimensions"]), missing: z.array(z.string()) }).strict(),
        })
        .strict(),
    ),
  })
  .strict();
export type SkillAnalyticsResponse = z.infer<typeof SkillAnalyticsResponseSchema>;
