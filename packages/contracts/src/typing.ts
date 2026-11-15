import { z } from "zod";
import { DictationOverviewSchema } from "./typingDictation.js";

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

/** letter-pair facts of a finished session: "th" typed correctly `count` times in `totalMs` of key intervals, `errors` wrong keys when the second letter was expected */
export const KeyStatSchema = z.object({ pair: z.string().regex(/^[a-z-]{2}$/), count: z.number().int().min(0).max(100000), totalMs: z.number().int().min(0).max(100_000_000), errors: z.number().int().min(0).max(100000) }).strict();
export type KeyStatPayload = z.infer<typeof KeyStatSchema>;
const KeyStats = z.array(KeyStatSchema).max(1200).optional();

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
    keyStats: KeyStats,
    /** words in a row without a wrong key (Words) */
    bestCombo: z.number().int().min(0).max(100000).optional(),
    bestCharStreak: z.number().int().min(0).max(10_000_000).optional(),
  })
  .strict();
export type TypingWordsCompleteRequest = z.infer<typeof TypingWordsCompleteRequestSchema>;

export const TypingAbortRequestSchema = z
  .object({ activeMs: Counters.activeMs.optional(), charsTyped: Counters.charsTyped.optional(), errors: Counters.errors.optional() })
  .strict();
export type TypingAbortRequest = z.infer<typeof TypingAbortRequestSchema>;

/* ---- Finger Drills (TASK_033): the second Words variant, a few comfortable words typed many times ---- */

export const TYPING_DRILL_RULES_VERSION = "drill-rules-v2";
export const TypingWordsVariantSchema = z.enum(["meteors", "drills"]);
export type TypingWordsVariant = z.infer<typeof TypingWordsVariantSchema>;

/** one showing of a word in the drill (the same lemma appears many times, each with its own planIndex) */
export const TypingDrillWordSchema = z
  .object({
    planIndex: z.number().int().nonnegative(),
    lemma: z.string().min(1).max(60),
    source: z.enum(["general", "vocabulary"]),
    vocabularyEntryId: z.string().nullable(),
    translationRu: z.string().nullable(),
    /** the translation is printed under this showing (every fifth showing of the word, from the first) */
    showTranslation: z.boolean(),
    /** Piper says the word after this showing (every tenth showing of the word) */
    speak: z.boolean(),
    /** the word was already learned before this level: a review showing */
    review: z.boolean(),
  })
  .strict();
export type TypingDrillWord = z.infer<typeof TypingDrillWordSchema>;

export const TypingDrillsStartResponseSchema = z
  .object({
    sessionId: z.string(),
    level: z.number().int().positive(),
    /** 1..6: which keys and word lengths are open */
    stage: z.number().int().positive(),
    stageKeys: z.string(),
    words: z.array(TypingDrillWordSchema),
    speed: TypingSpeedSchema,
    /** every wrong key costs one life; none left ends the level. Set from the learner's recent error rate and the level's length */
    lives: z.number().int().positive(),
    learned: z.number().int().nonnegative(),
  })
  .strict();
export type TypingDrillsStartResponse = z.infer<typeof TypingDrillsStartResponseSchema>;

export const TypingDrillsCompleteRequestSchema = z
  .object({
    status: z.enum(["completed", "failed"]),
    ...Counters,
    /** every word that was reached, in order: completed ones (with the time from the first letter to the space) and the one being typed */
    words: z
      .array(z.object({ planIndex: z.number().int().nonnegative(), errors: z.number().int().min(0).max(1000), completed: z.boolean(), typeMs: z.number().int().min(0).max(600_000).nullable() }).strict())
      .max(300),
    keyStats: KeyStats,
    bestCombo: z.number().int().min(0).max(100000).optional(),
    bestCharStreak: z.number().int().min(0).max(10_000_000).optional(),
  })
  .strict();
export type TypingDrillsCompleteRequest = z.infer<typeof TypingDrillsCompleteRequestSchema>;

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
    keyRulesVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    charStreak: z.object({ current: z.number().int().nonnegative(), best: z.number().int().nonnegative() }).nullable().optional(),
    /** the book text from startOffset to endOffset; the client indexes it as offset - startOffset */
    text: z.string(),
    chapters: z.array(z.object({ title: z.string(), startOffset: z.number().int(), endOffset: z.number().int() })),
    /** length of the whole prepared book, to show progress through it */
    textLength: z.number().int().nonnegative(),
    percentRead: z.number(),
    activeMs: z.number().int(),
    charsTyped: z.number().int(),
    errors: z.number().int(),
    bookWordTracking: z.object({ fromOffset: z.number().int().nonnegative(), errorOffsets: z.array(z.number().int().nonnegative()), reliable: z.boolean() }).strict().nullable().optional(),
  })
  .strict();
export type TypingBookStartResponse = z.infer<typeof TypingBookStartResponseSchema>;

const CharStreak = z.object({ current: z.number().int().min(0).max(10_000_000), best: z.number().int().min(0).max(10_000_000) }).strict();
const BookWordObservations = z.object({ errorOffsets: z.array(z.number().int().nonnegative()).max(10000) }).strict().optional();
export const TypingBookCheckpointRequestSchema = z.object({ offset: z.number().int().nonnegative(), ...Counters, charStreak: CharStreak.optional(), wordObservations: BookWordObservations }).strict();
export type TypingBookCheckpointRequest = z.infer<typeof TypingBookCheckpointRequestSchema>;

/** bestCombo: the longest run of characters typed correctly (Precision Combo) */
export const TypingBookCompleteRequestSchema = z.object({ offset: z.number().int().nonnegative(), ...Counters, keyStats: KeyStats, bestCombo: z.number().int().min(0).max(10_000_000).optional(), charStreak: CharStreak.optional(), wordObservations: BookWordObservations }).strict();
export type TypingBookCompleteRequest = z.infer<typeof TypingBookCompleteRequestSchema>;

export const TypingOverviewSchema = z
  .object({
    dictation: DictationOverviewSchema,
    words: z
      .object({
        nextLevel: z.number().int(),
        completedLevel: z.number().int(),
        activeSessionId: z.string().nullable(),
        bankWords: z.number().int(),
        drills: z.object({ nextLevel: z.number().int(), stage: z.number().int(), learned: z.number().int(), activeSessionId: z.string().nullable() }).strict(),
        keys: z.object({ nextLesson: z.number().int(), openKeys: z.number().int(), focused: z.string().nullable() }).strict().nullable(),
      })
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
    /** Words only: Meteor Rain or Finger Drills */
    variant: TypingWordsVariantSchema.optional(),
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
    bookWords: z.object({ completed: z.number().int(), withErrors: z.number().int(), partial: z.boolean() }).strict().nullable().optional(),
    book: z.object({ title: z.string(), chapter: z.string().nullable(), percentRead: z.number(), finished: z.boolean() }).strict().optional(),
    /** Finger Drills: the stage now, all learned words now, and the words this level made learned */
    drills: z.object({ stage: z.number().int(), learned: z.number().int(), newlyLearned: z.array(z.string()) }).strict().optional(),
  })
  .strict();
export type TypingResult = z.infer<typeof TypingResultSchema>;

const Point = z.object({ at: z.string(), value: z.number(), status: z.string() }).strict();

export const TypingAnalyticsModeSchema = z.enum(["words", "books", "drills", "keys"]);

/** keybr.com's per-key view, for every typing mode (derived from the raw key and letter-pair facts) */
export const TypingKeyboardAnalyticsSchema = z
  .object({
    goalCpm: z.number().int(),
    /** the accuracy a key must keep (0..1); the share of wrong presses it may have is 1 minus this */
    minAccuracy: z.number(),
    keys: z.array(
      z
        .object({
          letter: z.string(),
          lessons: z.number().int(),
          /** smoothed speed now and the best smoothed speed ever, characters per minute */
          cpm: z.number().nullable(),
          bestCpm: z.number().nullable(),
          /** against the goal: 1 = at the goal speed */
          confidence: z.number().nullable(),
          bestConfidence: z.number().nullable(),
          hits: z.number().int(),
          misses: z.number().int(),
          errorRate: z.number().nullable(),
          readiness: z.number(),
          /** the key's learning curve: raw and smoothed speed per lesson, oldest first */
          curve: z.array(z.object({ at: z.string(), cpm: z.number(), smoothed: z.number() }).strict()),
        })
        .strict(),
    ),
    /** straight line through the speed of the last 50 sessions, to the goal */
    forecast: z.object({ cpmPerLesson: z.number(), lessonsToGoal: z.number().int().nullable(), hoursToGoal: z.number().nullable() }).strict().nullable(),
  })
  .strict();
export type TypingKeyboardAnalytics = z.infer<typeof TypingKeyboardAnalyticsSchema>;
export type TypingAnalyticsMode = z.infer<typeof TypingAnalyticsModeSchema>;

export const TypingAnalyticsSchema = z
  .object({
    mode: TypingAnalyticsModeSchema,
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
        /** characters typed in all finished attempts of this mode, and the best combo (Words: words in a row; Books: characters in a row) */
        totalChars: z.number().int().optional(),
        bestCombo: z.number().int().nullable().optional(),
        bestCharStreak: z.number().int().nullable().optional(),
        /** Key Builder only: the alphabet now and the speeds it is judged by */
        keyBuilder: z.object({ openKeys: z.number().int(), focused: z.string().nullable(), targetCpm: z.number().int(), goalCpm: z.number().int(), currentCpm: z.number().int(), keys: z.lazy(() => z.array(TypingKeyStateSchema)) }).strict().optional(),
        /** Words only: the memory check after levels (words typed from their translation) */
        recall: z.object({ checks: z.number().int(), words: z.number().int(), withoutHelpRate: z.number().nullable(), avgPoints: z.number().nullable() }).strict().optional(),
        /** Finger Drills only: current stage, learned words and words practised at least once */
        drills: z
          .object({
            stage: z.number().int(),
            learned: z.number().int(),
            practised: z.number().int(),
            /** a clean level moves a learned word to rarer reviews at or below this time per letter (90% of the usual speed in the other modes) */
            targetMsPerLetter: z.number().int(),
            /** a word is learned when this share of its last `accuracyWindow` showings was perfect, after `minShowings` showings */
            accuracyNeeded: z.number(),
            minShowings: z.number().int(),
            accuracyWindow: z.number().int(),
            maxStep: z.number().int(),
            /** the most recently practised words; step 0 = in practice, 1..maxStep = learned review step */
            words: z.array(
              z
                .object({
                  lemma: z.string(),
                  showings: z.number().int(),
                  accuracy: z.number(),
                  step: z.number().int(),
                  msPerLetter: z.number().int().nullable(),
                  learned: z.boolean(),
                  nextInLevels: z.number().int().nullable(),
                  /** time per letter (ms) of every timed showing, oldest first */
                  speed: z.array(z.number().int()),
                  /** perfect share (%) of the recent showings after each showing, oldest first */
                  trend: z.array(z.number().int()),
                })
                .strict(),
            ),
          })
          .strict()
          .optional(),
      })
      .strict(),
    /** letter pairs that are slow or often mistyped, over all finished Words and Books sessions */
    keyInsights: z
      .object({
        slowPairs: z.array(z.object({ pair: z.string(), meanMs: z.number(), count: z.number().int() }).strict()),
        errorPairs: z.array(z.object({ pair: z.string(), errorRate: z.number(), count: z.number().int() }).strict()),
        typicalMs: z.number().nullable(),
      })
      .strict(),
    series: z
      .object({
        wpm: z.array(Point),
        accuracy: z.array(Point),
        score: z.array(Point),
        /** every day of the window, zero when nothing happened */
        daily: z.array(z.object({ date: z.string(), attempts: z.number().int(), activeSeconds: z.number().int(), chars: z.number().int().optional(), cumulativeChars: z.number().int().optional() }).strict()),
        duration: z.array(Point),
        personalBest: z.array(z.object({ at: z.string(), wpm: z.number(), score: z.number() }).strict()),
        charStreak: z.array(z.object({ at: z.string(), value: z.number().int().nullable(), status: z.string() }).strict()).optional(),
        /** Finger Drills: per finished level, typed words without and with errors, and the learned words after it */
        drillProgress: z.array(z.object({ at: z.string(), status: z.string(), clean: z.number().int(), withErrors: z.number().int(), learned: z.number().int() }).strict()).optional(),
        /** Key Builder: open keys and the target speed when each lesson was made */
        keyProgress: z
          .array(
            z
              .object({
                at: z.string(),
                open: z.number().int(),
                targetCpm: z.number().int(),
                /** the lesson's own speed and accuracy (percent) */
                wpm: z.number(),
                accuracy: z.number().nullable(),
                /** the accuracy limit a key must keep to count as reached, percent */
                accuracyLimit: z.number(),
                /** letters that opened since the previous finished lesson */
                newKeys: z.array(z.string()),
              })
              .strict(),
          )
          .optional(),
        bookWordAccuracy: z.array(z.object({ at: z.string(), completed: z.number().int(), withErrors: z.number().int(), partial: z.boolean() }).strict()).optional(),
      })
      .strict(),
    keyboard: TypingKeyboardAnalyticsSchema.optional(),
  })
  .strict();
export type TypingAnalytics = z.infer<typeof TypingAnalyticsSchema>;

/** `sentence`: an example of the word from the dictionary with the word blanked out ("____"), or null when there is none */
export const TypingRecallWordSchema = z.object({ entryId: z.string(), lemma: z.string(), translationRu: z.string(), sentence: z.string().nullable() }).strict();
export const TypingRecallStartResponseSchema = z.object({ words: z.array(TypingRecallWordSchema), done: z.boolean(), points: z.number().int() }).strict();
export type TypingRecallWord = z.infer<typeof TypingRecallWordSchema>;
export type TypingRecallStartResponse = z.infer<typeof TypingRecallStartResponseSchema>;
export const TypingRecallSaveRequestSchema = z
  .object({
    results: z
      .array(z.object({ entryId: z.string().min(1).max(64), correctKeys: z.number().int().min(0).max(64), wrongKeys: z.number().int().min(0).max(1000), hints: z.number().int().min(0).max(64), revealed: z.boolean() }).strict())
      .min(1)
      .max(3),
  })
  .strict();
export type TypingRecallSaveRequest = z.infer<typeof TypingRecallSaveRequestSchema>;

/** Key Builder (keybr.com guided lessons): letters open one by one as the open ones reach the target speed */
export const TYPING_KEYS_RULES_VERSION = "keys-guided-v2";
export const TYPING_KEYS_XP_VERSION = "typing-keys-xp-v1";

export const TypingKeyStateSchema = z
  .object({
    letter: z.string(),
    included: z.boolean(),
    focused: z.boolean(),
    /** target time / smoothed time per press; 1 = at the target speed */
    confidence: z.number().nullable(),
    bestConfidence: z.number().nullable(),
    /** smoothed speed of this key, characters per minute */
    cpm: z.number().nullable(),
    lessons: z.number().int(),
    /** smoothed share of wrong presses of this key */
    errorRate: z.number().nullable(),
    /** speed and accuracy together: 1 or more = the key has reached the target */
    readiness: z.number(),
  })
  .strict();
export type TypingKeyState = z.infer<typeof TypingKeyStateSchema>;

export const TypingKeyTokenSchema = z.object({ text: z.string(), kind: z.enum(["word", "pseudo"]), translationRu: z.string().nullable() }).strict();
export type TypingKeyToken = z.infer<typeof TypingKeyTokenSchema>;

export const TypingKeysStartResponseSchema = z
  .object({
    lessonId: z.string(),
    lessonNumber: z.number().int().positive(),
    /** the target of the current stage: fixed when its letter opened, at the speed then, never above the goal */
    targetCpm: z.number().int(),
    goalCpm: z.number().int(),
    keys: z.array(TypingKeyStateSchema),
    tokens: z.array(TypingKeyTokenSchema),
  })
  .strict();
export type TypingKeysStartResponse = z.infer<typeof TypingKeysStartResponseSchema>;

const KeyFact = z.object({ letter: z.string().regex(/^[a-z]$/), hits: z.number().int().min(0).max(10000), misses: z.number().int().min(0).max(10000), meanMs: z.number().int().min(0).max(60000) }).strict();
export const TypingKeysCompleteRequestSchema = z.object({ ...Counters, keys: z.array(KeyFact).max(26), keyStats: KeyStats, bestCharStreak: z.number().int().min(0).max(100000).optional() }).strict();
export type TypingKeysCompleteRequest = z.infer<typeof TypingKeysCompleteRequestSchema>;

export const TypingKeysGoalForecastSchema = z.object({ cpmPerLesson: z.number(), lessonsToGoal: z.number().int().nullable(), hoursToGoal: z.number().nullable() }).strict();

export const TypingKeysResultSchema = z
  .object({
    lessonId: z.string(),
    lessonNumber: z.number().int(),
    targetCpm: z.number().int(),
    goalCpm: z.number().int(),
    /** median speed of the recent lessons */
    currentCpm: z.number().int(),
    goalForecast: TypingKeysGoalForecastSchema.nullable(),
    cpm: z.number(),
    wpm: z.number(),
    accuracy: z.number(),
    activeMs: z.number().int(),
    errors: z.number().int(),
    /** speed of the previous completed lesson, for comparison */
    previousCpm: z.number().nullable(),
    xpAwarded: z.number().int(),
    keys: z.array(TypingKeyStateSchema),
    /** letters this lesson opened */
    newKeys: z.array(z.string()),
    /** what the next letter waits for: every open key against the stage target, with this lesson's numbers and a rough outlook */
    nextKey: z
      .object({
        /** the letter that opens next; null when the whole alphabet is open */
        letter: z.string().nullable(),
        targetCpm: z.number().int(),
        minAccuracy: z.number(),
        /** 0..1: how close every open key is to the target (mean of each key's weaker part, speed or accuracy); 1 opens the next letter */
        progress: z.number(),
        keys: z.array(
          z
            .object({
              letter: z.string(),
              /** lessons this key has facts from */
              lessons: z.number().int(),
              /** 0..1: best speed against the target */
              speedProgress: z.number(),
              /** 0..1: how far the key is from the accuracy limit (1 = within it) */
              accuracyProgress: z.number(),
              /** the key's smoothed (average) speed now */
              cpm: z.number().nullable(),
              /** the best that smoothed speed ever reached: this is what is judged */
              bestCpm: z.number().nullable(),
              /** smoothed share of wrong presses, weighted by presses */
              errorRate: z.number().nullable(),
              /** its lower bound allowing for chance: what is judged against the limit */
              errorBound: z.number().nullable(),
              /** raw share of wrong presses over the key's last 10 lessons */
              recentErrorRate: z.number().nullable(),
              speedReached: z.boolean(),
              accuracyReached: z.boolean(),
              /** lessons until reached at the recent pace and accuracy; 0 = reached; null = no honest estimate */
              lessonsLeft: z.number().int().nullable(),
              /** the fewest lessons for the accuracy part: every one without a mistake on this key */
              cleanLessonsLeft: z.number().int().nullable(),
              /** this lesson only */
              lesson: z.object({ cpm: z.number().nullable(), hits: z.number().int(), misses: z.number().int() }).strict().nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
    /** speed forecast of the focused key (keybr learning rate); null while the data is too thin */
    forecast: z.object({ letter: z.string(), cpmPerLesson: z.number(), remainingLessons: z.number().int().nullable(), certainty: z.number() }).strict().nullable(),
    lessonsToday: z.number().int(),
  })
  .strict();
export type TypingKeysResult = z.infer<typeof TypingKeysResultSchema>;

