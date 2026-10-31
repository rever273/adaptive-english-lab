import { z } from "zod";

/** Error envelope shared by every /api/v1 failure (spec/02 "HTTP v1"). */
export const ErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.unknown().nullable(),
        requestId: z.string(),
      })
      .strict(),
  })
  .strict();
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export const DbPragmasSchema = z
  .object({
    journal_mode: z.string(),
    foreign_keys: z.number().int(),
    busy_timeout: z.number().int(),
    synchronous: z.number().int(),
  })
  .strict();

/** GET /api/v1/health */
export const HealthSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    appVersion: z.string(),
    instanceId: z.string(),
    startedAt: z.string(),
    time: z.string(),
    node: z.object({ version: z.string() }).strict(),
    db: z
      .object({
        ready: z.boolean(),
        schemaVersion: z.number().int(),
        driver: z.string(),
        driverVersion: z.string(),
        sqliteVersion: z.string(),
        jsonSupport: z.boolean(),
        pragmas: DbPragmasSchema,
      })
      .strict(),
    degradedReasons: z.array(z.string()),
  })
  .strict();
export type Health = z.infer<typeof HealthSchema>;

export const ComponentStatusSchema = z.enum(["not_implemented", "unavailable", "ready"]);

/** GET /api/v1/capabilities - no secrets, no paths. */
export const CapabilitiesSchema = z
  .object({
    versions: z
      .object({ app: z.string(), node: z.string(), schema: z.number().int() })
      .strict(),
    db: z.object({ status: z.enum(["ready", "unavailable"]) }).strict(),
    ui: z.object({ built: z.boolean() }).strict(),
    ai: z
      .object({ ollama: ComponentStatusSchema, nimble: ComponentStatusSchema, qwen: ComponentStatusSchema })
      .strict(),
    stt: z.object({ status: ComponentStatusSchema }).strict(),
    degradedReasons: z.array(z.string()),
  })
  .strict();
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/** settings_revisions.values_json (spec/01 "Параметры"; Advanced keys are added by later tasks). */
export const SettingsV1Schema = z
  .object({
    schema_version: z.literal("settings-v1"),
    taskCount: z.number().int().min(5).max(30),
    weakRatio: z.number().min(0).max(1),
    voiceTarget: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    difficulty: z.enum(["adaptive", "B2", "B2-C1"]),
    explanation: z.enum(["compact", "detailed"]),
    vocabularyShare: z.number().min(0).max(0.25),
    stockWarning: z.number().int().min(1).max(20),
    vocabularyTaskCount: z.number().int().min(5).max(10).optional(),
    /** D64/TASK_020: at most this many words never practised before enter one vocabulary session (default 4) */
    vocabularyNewWordsPerSession: z.number().int().min(1).max(10).optional(),
    /** D64: share of the session's tasks offered for voice (0..1). When set it replaces voiceTarget; older revisions do not have it. */
    voiceShare: z.number().min(0).max(1).optional(),
  })
  .strict();
export type SettingsV1 = z.infer<typeof SettingsV1Schema>;

/** Older settings revisions predate vocabulary sessions. */
export const vocabularyTaskCount = (v: Pick<SettingsV1, "vocabularyTaskCount">): number => v.vocabularyTaskCount ?? 8;

export const vocabularyNewWordsPerSession = (v: Pick<SettingsV1, "vocabularyNewWordsPerSession">): number => v.vocabularyNewWordsPerSession ?? 4;

/** How many tasks of a session are offered for voice: the share of the task count, rounded; otherwise the old fixed count. */
export const voiceTaskCount = (v: Pick<SettingsV1, "taskCount" | "voiceTarget" | "voiceShare">): number => (v.voiceShare !== undefined ? Math.round(v.voiceShare * v.taskCount) : v.voiceTarget);

export const DEFAULT_SETTINGS_V1: SettingsV1 = {
  schema_version: "settings-v1",
  taskCount: 18,
  weakRatio: 0.65,
  voiceTarget: 2,
  difficulty: "adaptive",
  explanation: "compact",
  vocabularyShare: 0.12,
  stockWarning: 3,
};
export * from "./attempts.js";
export * from "./analytics.js";
export * from "./exercises.js";
export * from "./vocabulary-practice.js";
export * from "./sessions.js";
export * from "./batches.js";
