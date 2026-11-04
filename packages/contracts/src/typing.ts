import { z } from "zod";

export const TypingModeSchema = z.enum(["words", "books"]);
export type TypingMode = z.infer<typeof TypingModeSchema>;

export const TYPING_METRICS_VERSION = "typing-metrics-v2";
export const TYPING_SPEED_VERSION = "typing-speed-v3";
export const TYPING_XP_VERSION = "typing-xp-v2";

export const TypingPlanWordSchema = z
  .object({
    planIndex: z.number().int().nonnegative(),
    lemma: z.string().min(1).max(60),
    source: z.enum(["general", "vocabulary"]),
    vocabularyEntryId: z.string().nullable(),
    /** shown during the game only for source = vocabulary; for general only in the result list */
    translationRu: z.string().nullable(),
    partOfSpeech: z.string().nullable(),
    definitionRu: z.string().nullable(),
    transcription: z.string().nullable(),
    /** general words come from the old unverified list */
    unverified: z.boolean(),
    fallMs: z.number().int().positive(),
  })
  .strict();
export type TypingPlanWord = z.infer<typeof TypingPlanWordSchema>;

export const TypingSpeedSchema = z
  .object({
    ruleVersion: z.string(),
    estimateWpm: z.number().positive(),
    multiplier: z.number().positive(),
    pressure: z.number().positive(),
    effectiveWpm: z.number().positive(),
    msPerChar: z.number().positive(),
  })
  .strict();
export type TypingSpeed = z.infer<typeof TypingSpeedSchema>;

export const TypingWordsStartResponseSchema = z
  .object({
    sessionId: z.string(),
    level: z.number().int().positive(),
    targetCount: z.number().int().positive(),
    words: z.array(TypingPlanWordSchema),
    speed: TypingSpeedSchema,
  })
  .strict();
export type TypingWordsStartResponse = z.infer<typeof TypingWordsStartResponseSchema>;

const Appearance = z.object({ planIndex: z.number().int().nonnegative(), order: z.number().int().nonnegative() }).strict();
const Counters = { activeMs: z.number().int().nonnegative(), charsTyped: z.number().int().nonnegative(), errors: z.number().int().nonnegative() };

export const TypingAppearancesRequestSchema = z.object({ appearances: z.array(Appearance).min(1).max(200) }).strict();
export type TypingAppearancesRequest = z.infer<typeof TypingAppearancesRequestSchema>;

export const TypingWordsCompleteRequestSchema = z
  .object({
    status: z.enum(["completed", "failed"]),
    ...Counters,
    /** re-sent in full, so a lost /appearances request costs nothing */
    appearances: z.array(Appearance).max(200),
    destroyedPlanIndexes: z.array(z.number().int().nonnegative()).max(200),
    /** wrong keys pressed while each word that appeared was locked (0 = clean); older clients send none */
    wordErrors: z.array(z.object({ planIndex: z.number().int().nonnegative(), errors: z.number().int().min(0).max(1000) }).strict()).max(200).optional(),
  })
  .strict();
export type TypingWordsCompleteRequest = z.infer<typeof TypingWordsCompleteRequestSchema>;

export const TypingAbortRequestSchema = z
  .object({ activeMs: Counters.activeMs.optional(), charsTyped: Counters.charsTyped.optional(), errors: Counters.errors.optional() })
  .strict();
export type TypingAbortRequest = z.infer<typeof TypingAbortRequestSchema>;

export const TypingBookStartResponseSchema = z
  .object({
    sessionId: z.string(),
    bookId: z.string(),
    title: z.string(),
    author: z.string(),
    level: z.number().int().positive(),
    startOffset: z.number().int(),
    endOffset: z.number().int(),
    currentOffset: z.number().int(),
    /** the book text from startOffset to endOffset; the client indexes it as offset - startOffset */
    text: z.string(),
    chapters: z.array(z.object({ title: z.string(), startOffset: z.number().int(), endOffset: z.number().int() })),
    /** length of the whole prepared book, to show progress through it */
    textLength: z.number().int().nonnegative(),
    percentRead: z.number(),
    activeMs: z.number().int(),
    charsTyped: z.number().int(),
    errors: z.number().int(),
  })
  .strict();
export type TypingBookStartResponse = z.infer<typeof TypingBookStartResponseSchema>;

export const TypingBookCheckpointRequestSchema = z.object({ offset: z.number().int().nonnegative(), ...Counters }).strict();
export type TypingBookCheckpointRequest = z.infer<typeof TypingBookCheckpointRequestSchema>;

export const TypingBookCompleteRequestSchema = z.object({ offset: z.number().int().nonnegative(), ...Counters }).strict();
export type TypingBookCompleteRequest = z.infer<typeof TypingBookCompleteRequestSchema>;

export const TypingOverviewSchema = z
  .object({
    words: z
      .object({ nextLevel: z.number().int(), completedLevel: z.number().int(), activeSessionId: z.string().nullable(), bankWords: z.number().int() })
      .strict(),
    books: z
      .object({
        available: z.boolean(),
        reason: z.enum(["no_book", "file_missing", "file_changed"]).nullable(),
        finished: z.boolean(),
        bookId: z.string().nullable(),
        title: z.string().nullable(),
        level: z.number().int(),
        chapter: z.string().nullable(),
        offset: z.number().int(),
        percentRead: z.number().nullable(),
        activeSessionId: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export type TypingOverview = z.infer<typeof TypingOverviewSchema>;

export const TypingResultSchema = z
  .object({
    sessionId: z.string(),
    mode: TypingModeSchema,
    status: z.enum(["completed", "failed", "interrupted"]),
    level: z.number().int(),
    metrics: z
      .object({
        wpm: z.number(),
        cpm: z.number(),
        accuracy: z.number().nullable(),
        errors: z.number().int(),
        score: z.number().int(),
        activeMs: z.number().int(),
        charsCorrect: z.number().int(),
        charsTyped: z.number().int(),
      })
      .strict(),
    best: z.object({ wpm: z.number().nullable(), score: z.number().nullable() }).strict(),
    /** null when there is no comparable earlier result: never an invented percentage */
    comparison: z.object({ percent: z.number(), faster: z.boolean() }).strict().nullable(),
    skill: z.enum(["Developing", "Comfortable", "Fast", "Very Fast", "Excellent"]),
    xpAwarded: z.number().int(),
    words: z.array(TypingPlanWordSchema.omit({ fallMs: true }).extend({ destroyed: z.boolean(), order: z.number().int(), errors: z.number().int().nullable() })).optional(),
    wordsShown: z.number().int().optional(),
    wordsDestroyed: z.number().int().optional(),
    /** destroyed words by wrong keys: none, exactly one, two or more (only when the client reported them) */
    wordErrorBands: z.object({ clean: z.number().int(), one: z.number().int(), many: z.number().int() }).strict().optional(),
    book: z.object({ title: z.string(), chapter: z.string().nullable(), percentRead: z.number(), finished: z.boolean() }).strict().optional(),
  })
  .strict();
export type TypingResult = z.infer<typeof TypingResultSchema>;

const Point = z.object({ at: z.string(), value: z.number(), status: z.string() }).strict();

export const TypingAnalyticsSchema = z
  .object({
    mode: TypingModeSchema,
    window: z.object({ days: z.number().nullable(), timezone: z.string() }).strict(),
    summary: z
      .object({
        totalActiveMs: z.number(),
        attempts: z.number().int(),
        completed: z.number().int(),
        failed: z.number().int(),
        interrupted: z.number().int(),
        avgWpm: z.number().nullable(),
        maxWpm: z.number().nullable(),
        avgAccuracy: z.number().nullable(),
        maxScore: z.number().nullable(),
        last: TypingResultSchema.nullable(),
        wordsShown: z.number().int().optional(),
        wordsDestroyed: z.number().int().optional(),
        currentLevel: z.number().int().optional(),
        chapter: z.string().nullable().optional(),
        percentRead: z.number().nullable().optional(),
      })
      .strict(),
    series: z
      .object({
        wpm: z.array(Point),
        accuracy: z.array(Point),
        score: z.array(Point),
        /** every day of the window, zero when nothing happened */
        daily: z.array(z.object({ date: z.string(), attempts: z.number().int(), activeSeconds: z.number().int() }).strict()),
        duration: z.array(Point),
        personalBest: z.array(z.object({ at: z.string(), wpm: z.number(), score: z.number() }).strict()),
      })
      .strict(),
  })
  .strict();
export type TypingAnalytics = z.infer<typeof TypingAnalyticsSchema>;
