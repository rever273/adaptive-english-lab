import { z } from "zod";

export const DICTATION_CHECK_VERSION = "dictation-check-v1";
export const DICTATION_XP_VERSION = "typing-dictation-xp-v1";
export const DICTATION_METRICS_VERSION = "dictation-metrics-v1";

export const DictationUnavailableReasonSchema = z.enum(["tts_not_installed", "tts_model_missing", "asr_unavailable"]);

/** effective state, see lessons.ts: `failed` also covers a lesson whose jobs ended without all sentences */
export const DictationLessonSummarySchema = z.object({
  id: z.string(), level: z.number().int().positive(),
  status: z.enum(["generating", "ready", "failed", "completed"]),
  ready: z.number().int(), total: z.number().int(), started: z.boolean(),
}).strict();

export const DictationOverviewSchema = z.object({
  available: z.boolean(), reason: DictationUnavailableReasonSchema.nullable(),
  nextLevel: z.number().int().positive(), lesson: DictationLessonSummarySchema.nullable(),
  /** tracks made ahead of time: ready to be used by the next lessons / still being made */
  pool: z.object({ prepared: z.number().int(), generating: z.number().int() }).strict(),
}).strict();

export const DictationWordSchema = z.object({ text: z.string().nullable() /* null while hidden */, index: z.number().int() }).strict();

export const DictationExerciseStateSchema = z.object({
  id: z.string(), ordinal: z.number().int(), done: z.boolean(),
  /** D86: may be sent to the client; the interface shows only revealed `words` until the lesson ends */
  textEn: z.string(),
  words: z.array(DictationWordSchema),
  /** number of hints shown so far (not limited) */
  hintLevel: z.number().int().min(0),
  /** the sentence came back because it was answered with mistakes before */
  isRepeat: z.boolean(),
  translationRu: z.string().nullable(), // null until opened
  source: z.literal("tts"),
  attempts: z.number().int(), plays: z.number().int(), audioMs: z.number().int(),
  /** D128: the learner marked the sound of this sentence as bad */
  soundFlagged: z.boolean(),
}).strict();

export const DictationStateSchema = z.object({
  lessonId: z.string(), level: z.number().int(), status: DictationLessonSummarySchema.shape.status,
  currentOrdinal: z.number().int().nullable(), activeMs: z.number().int(),
  exercises: z.array(DictationExerciseStateSchema),
}).strict();

export const DictationPlayRequestSchema = z.object({ source: z.enum(["auto", "manual", "wrong_answer"]) }).strict();
export const DictationHintRequestSchema = z.object({ typedText: z.string().max(1000) }).strict();
/** typingMs: time spent typing this attempt (pauses over 5 s between keys are not counted); keystrokes: keys pressed. Both measured by the page. */
export const DictationAnswerRequestSchema = z.object({ attemptId: z.string().uuid(), text: z.string().min(1).max(1000), activeMs: z.number().int().nonnegative(), typingMs: z.number().int().min(0).max(3_600_000).optional(), keystrokes: z.number().int().min(0).max(10_000).optional() }).strict();
export const DictationPrepareRequestSchema = z.object({ count: z.number().int().min(1).max(50) }).strict();
export const DictationTimeRequestSchema = z.object({ activeMs: z.number().int().nonnegative() }).strict();

export const DictationHintResponseSchema = z.object({
  /** false when the answer is already complete: no hint spent, no event written */
  applied: z.boolean(), hintLevel: z.number().int(), words: z.array(DictationWordSchema),
}).strict();

export const DictationAnswerResponseSchema = z.object({
  correct: z.boolean(), xpAwarded: z.number().int(), lessonCompleted: z.boolean(),
  hintLevel: z.number().int(), words: z.array(DictationWordSchema), nextOrdinal: z.number().int().nullable(),
}).strict();

export const DictationResultSchema = z.object({
  lessonId: z.string(), level: z.number().int(), sentences: z.number().int(), activeMs: z.number().int(),
  score: z.number().int(), xpAwarded: z.number().int(),
  /** typing speed of the lesson: correct characters / 5 per minute of typing (null without timing) */
  wpm: z.number().nullable(), cpm: z.number().nullable(), typingMs: z.number().int(),
  firstAttemptCorrect: z.number().int(), noHelp: z.number().int(), partial: z.number().int(), fullReveal: z.number().int(),
  wrongSubmissions: z.number().int(), plays: z.number().int(), manualReplays: z.number().int(), avgPlaysPerSentence: z.number(),
  metricsVersion: z.string(),
  items: z.array(z.object({
    ordinal: z.number().int(), textEn: z.string(), translationRu: z.string(), topic: z.string(), targetSkillId: z.string().nullable(),
    voiceName: z.string().nullable(), source: z.literal("tts"), plays: z.number().int(), attempts: z.number().int(),
    maxHintLevel: z.number().int(), outcome: z.enum(["no_help", "partial", "full_reveal"]), firstAnswer: z.string(),
    diff: z.array(z.object({ op: z.enum(["same", "missing", "extra", "wrong"]), expected: z.string().nullable(), typed: z.string().nullable() }).strict()),
    /** what kind of mistakes the first answer had (approximate, from comparing the words; never changes Grammar Mastery) */
    errorTypes: z.array(z.string()),
  }).strict()),
}).strict();

export const DictationAnalyticsSchema = z.object({
  window: z.object({ days: z.number().nullable(), timezone: z.string() }).strict(),
  summary: z.object({
    lessons: z.number().int(), exercises: z.number().int(), totalActiveMs: z.number(),
    firstAttemptAccuracy: z.number().nullable(), noHelpRate: z.number().nullable(), avgManualReplays: z.number().nullable(),
    dictationAccuracy: z.number().nullable(), translationUsedRate: z.number().nullable(),
    avgWpm: z.number().nullable(), bestWpm: z.number().nullable(), avgCpm: z.number().nullable(), typingTotalMs: z.number(),
    totalChars: z.number().int(), bestScore: z.number().nullable(), avgHints: z.number().nullable(),
    hintUsage: z.object({ none: z.number().int(), level1: z.number().int(), level2: z.number().int(), level3: z.number().int() }).strict(),
  }).strict(),
  daily: z.array(z.object({ date: z.string(), lessons: z.number().int(), exercises: z.number().int(), activeSeconds: z.number().int() }).strict()),
  series: z.array(z.object({ at: z.string(), score: z.number(), firstAttemptAccuracy: z.number(), wpm: z.number().nullable(), independent: z.number(), replays: z.number().nullable(), hints: z.number().nullable() }).strict()),
  /** mistakes of the first answers by kind (approximate; no AI, no effect on Mastery) */
  errorTypes: z.array(z.object({ type: z.string(), label: z.string(), count: z.number().int(), share: z.number() }).strict()),
  /** how the Whisper check hears each voice and the share of sentences it gets now (a voice that is often misheard gets a smaller share) */
  voiceBalance: z.array(z.object({ name: z.string(), ageGroup: z.string().nullable(), checks: z.number().int(), heardRate: z.number().nullable(), weight: z.number(), share: z.number(), flags: z.number().int(), enabled: z.boolean() }).strict()),
  /** a voice is listed with `enoughData: false` below 20 exercises and its numbers are then null */
  voices: z.array(z.object({ name: z.string(), exercises: z.number().int(), enoughData: z.boolean(), firstAttemptAccuracy: z.number().nullable(), avgManualReplays: z.number().nullable(), hintRate: z.number().nullable() }).strict()),
}).strict();

export type DictationUnavailableReason = z.infer<typeof DictationUnavailableReasonSchema>;
export type DictationLessonSummary = z.infer<typeof DictationLessonSummarySchema>;
export type DictationOverview = z.infer<typeof DictationOverviewSchema>;
export type DictationWord = z.infer<typeof DictationWordSchema>;
export type DictationExerciseState = z.infer<typeof DictationExerciseStateSchema>;
export type DictationState = z.infer<typeof DictationStateSchema>;
export type DictationPlayRequest = z.infer<typeof DictationPlayRequestSchema>;
export type DictationHintRequest = z.infer<typeof DictationHintRequestSchema>;
export type DictationAnswerRequest = z.infer<typeof DictationAnswerRequestSchema>;
export type DictationTimeRequest = z.infer<typeof DictationTimeRequestSchema>;
export type DictationHintResponse = z.infer<typeof DictationHintResponseSchema>;
export type DictationAnswerResponse = z.infer<typeof DictationAnswerResponseSchema>;
export type DictationResult = z.infer<typeof DictationResultSchema>;
export type DictationAnalytics = z.infer<typeof DictationAnalyticsSchema>;
export type DictationPrepareRequest = z.infer<typeof DictationPrepareRequestSchema>;
