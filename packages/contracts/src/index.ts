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

/** D67: residency of the one local model */
export const ModelResidencyStateSchema = z.enum(["unloaded", "loading", "ready", "unloading", "error"]);
export type ModelResidencyState = z.infer<typeof ModelResidencyStateSchema>;

/** GET /api/v1/ai/model */
export const AiModelStatusSchema = z
  .object({
    state: ModelResidencyStateSchema,
    model: z.string(),
    loadedSince: z.string().nullable(),
    lastLoadMs: z.number().nullable(),
    vramBytes: z.number().nullable(),
    error: z.string().nullable(),
    busy: z.enum(["job_running", "practice_active", "loading", "unloading"]).nullable(),
    preloadOnStart: z.boolean(),
  })
  .strict();
export type AiModelStatus = z.infer<typeof AiModelStatusSchema>;

/** GET /api/v1/capabilities - no secrets, no paths. */
export const CapabilitiesSchema = z
  .object({
    versions: z
      .object({ app: z.string(), node: z.string(), schema: z.number().int() })
      .strict(),
    db: z.object({ status: z.enum(["ready", "unavailable"]) }).strict(),
    ui: z.object({ built: z.boolean() }).strict(),
    ai: z
      .object({
        ollama: ComponentStatusSchema,
        /** the ONE local model (D67): which tag the app uses and whether it is in memory right now */
        model: ComponentStatusSchema,
        modelTag: z.string(),
        modelState: ModelResidencyStateSchema,
      })
      .strict(),
    stt: z.object({ status: ComponentStatusSchema }).strict(),
    degradedReasons: z.array(z.string()),
  })
  .strict();
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/** Grammar exercise difficulty labels. */
export const CEFR_RANGE = ["A2", "B1", "B2", "C1", "C2"] as const;
export type CefrLevel = (typeof CEFR_RANGE)[number];

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
    /** how many times every word must be matched in the matching game's rush mode that closes a vocabulary practice (default 4) */
    vocabularyMatchRounds: z.number().int().min(1).max(10).optional(),
    /** TASK_032: sentences in one Grammar Cloze session (default 15); applies to the next session */
    clozeTaskCount: z.number().int().min(5).max(50).optional(),
    /** D67: warm the local model at start and when the learner arrives (default true) */
    preloadModelOnStart: z.boolean().optional(),
    /** Feedback and completion sounds; missing on older revisions means enabled. */
    practiceSoundsEnabled: z.boolean().optional(),
    /** Typing game sounds (shots, explosions, mistakes); separate from practice sounds; missing means enabled. */
    typingSoundsEnabled: z.boolean().optional(),
    /** D65: how many unresolved answers (the local AI could not settle them) collect before ONE non-blocking notice offers an agent task (default 5) */
    reviewNoticeThreshold: z.number().int().min(1).max(50).optional(),
    /** D64: share of the session's tasks offered for voice (0..1). When set it replaces voiceTarget; older revisions do not have it. */
    voiceShare: z.number().min(0).max(1).optional(),
    /** Target CEFR range; old revisions without bounds keep their historical A2-C1 meaning. */
    difficultyMin: z.enum(CEFR_RANGE).optional(),
    difficultyMax: z.enum(CEFR_RANGE).optional(),
    /** TASK_027: typing practice settings; missing on older revisions means the defaults. */
    typingWordsPerLevel: z.number().int().min(10).max(100).optional(),
    /** TASK_033: word showings in one Finger Drills level (repeats count); missing means 60 */
    typingDrillWordsPerLevel: z.number().int().min(20).max(200).optional(),
    /** TASK_033: Piper says every tenth drilled word; missing means off */
    typingDrillSpeech: z.boolean().optional(),
    /** unused (Key Builder's first fixed target); kept so a saved revision with it stays valid */
    typingKeysTargetCpm: z.number().int().min(75).max(750).optional(),
    /** Key Builder: the speed you are working towards, WPM; the opening target follows your real speed up to it. Missing means 55 */
    typingKeysGoalWpm: z.number().int().min(20).max(150).optional(),
    /** Key Builder: a key counts as reached only with at least this accuracy, percent; missing means 95 */
    typingKeysMinAccuracy: z.number().int().min(80).max(100).optional(),
    typingVocabularyShare: z.number().min(0).max(1).optional(),
    typingSpeedMultiplier: z.number().min(0.5).max(2).optional(),
    typingBookMinutes: z.number().int().min(1).max(30).optional(),
    /** Books: wrong letters are shown (and must be deleted); when false a wrong key is only counted and nothing appears. Missing means shown. */
    typingBooksShowMistakes: z.boolean().optional(),
    /** TASK_028: sentences in one Audio Dictation lesson; fixed in the lesson when it is created. Missing means 10. */
    typingDictationExercisesPerLesson: z.number().int().min(5).max(20).optional(),
    typingDictationSource: z.enum(["real", "tts"]).optional(),
    /** how many saved words the memory check after a Words level offers (0 = no check); missing means 2 */
    typingRecallWords: z.number().int().min(0).max(3).optional(),
    dailyOrder: z.array(z.enum(["grammar", "vocabulary", "words", "books", "dictation", "wordLesson", "grammarCloze", "conversation"])).min(5).max(8).refine(v => new Set(v).size === v.length).optional(),
    journeyHours: z.object({ b2: z.number().int().min(1).max(5000), c1: z.number().int().min(1).max(5000), c2: z.number().int().min(1).max(5000) }).strict().optional(),
    dailyMinutes: z.object({ grammar: z.number().int().min(0).max(180), vocabulary: z.number().int().min(0).max(180), words: z.number().int().min(0).max(180), books: z.number().int().min(0).max(180), dictation: z.number().int().min(0).max(180), wordLesson: z.number().int().min(0).max(180).optional(), grammarCloze: z.number().int().min(0).max(180).optional(), conversation: z.number().min(0).max(180).multipleOf(0.5).optional() }).strict().optional(),
  })
  .strict();
export type SettingsV1 = z.infer<typeof SettingsV1Schema>;

/** Older settings revisions predate vocabulary sessions. */
export const vocabularyTaskCount = (v: Pick<SettingsV1, "vocabularyTaskCount">): number => v.vocabularyTaskCount ?? 8;

/** TASK_032: sentences per Grammar Cloze session; missing on older revisions means 15. */
export const clozeTaskCount = (v: Pick<SettingsV1, "clozeTaskCount">): number => v.clozeTaskCount ?? 15;

export const preloadModelOnStart = (v: Pick<SettingsV1, "preloadModelOnStart">): boolean => v.preloadModelOnStart ?? true;

export const reviewNoticeThreshold = (v: Pick<SettingsV1, "reviewNoticeThreshold">): number => v.reviewNoticeThreshold ?? 5;

export const vocabularyNewWordsPerSession = (v: Pick<SettingsV1, "vocabularyNewWordsPerSession">): number => v.vocabularyNewWordsPerSession ?? 4;

export const vocabularyMatchRounds = (v: Pick<SettingsV1, "vocabularyMatchRounds">): number => v.vocabularyMatchRounds ?? 4;

export const typingWordsPerLevel = (v: Pick<SettingsV1, "typingWordsPerLevel">): number => v.typingWordsPerLevel ?? 30;

export const typingDrillWordsPerLevel = (v: Pick<SettingsV1, "typingDrillWordsPerLevel">): number => v.typingDrillWordsPerLevel ?? 60;

export const typingVocabularyShare = (v: Pick<SettingsV1, "typingVocabularyShare">): number => v.typingVocabularyShare ?? 0.3;

export const typingSpeedMultiplier = (v: Pick<SettingsV1, "typingSpeedMultiplier">): number => v.typingSpeedMultiplier ?? 1.05;

export const typingBookMinutes = (v: Pick<SettingsV1, "typingBookMinutes">): number => v.typingBookMinutes ?? 5;

export const typingRecallWords = (v: Pick<SettingsV1, "typingRecallWords">): number => v.typingRecallWords ?? 2;

export const typingDictationExercisesPerLesson = (v: Pick<SettingsV1, "typingDictationExercisesPerLesson">): number => v.typingDictationExercisesPerLesson ?? 10;

/**
 * The levels for grammar practice and new content, or null for the full A2-C2 range.
 * Historical revisions without bounds retain the formerly supported A2-C1 range.
 */
export const difficultyLevels = (v: Pick<SettingsV1, "difficultyMin" | "difficultyMax">): CefrLevel[] | null => {
  const lo = CEFR_RANGE.indexOf(v.difficultyMin ?? "A2");
  const hi = CEFR_RANGE.indexOf(v.difficultyMax ?? "C1");
  if (lo <= 0 && hi >= CEFR_RANGE.length - 1) return null;
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  return CEFR_RANGE.slice(a, b + 1);
};

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
  difficultyMin: "B1",
  difficultyMax: "C1",
};
export * from "./attempts.js";
export * from "./analytics.js";
export * from "./exercises.js";
export * from "./vocabulary-practice.js";
export * from "./sessions.js";
export * from "./batches.js";
export * from "./typing.js";
export * from "./typingText.js";
export * from "./typingDictation.js";
export * from "./dictationCheck.js";
export * from "./voices.js";
export * from "./wordLessons.js";
export * from "./grammarCloze.js";
