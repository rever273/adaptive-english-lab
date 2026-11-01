import { z } from "zod";

const Id = z.string().min(1).max(64);

/** POST /api/v1/sessions. Only `practice` exists until TASK_013 adds diagnostic/held-out protocols. */
export const CreateSessionRequestSchema = z
  .object({
    purpose: z.enum(["practice", "diagnostic", "heldout"]),
    blueprintRevisionId: Id.optional(),
    settingsRevisionId: Id.optional(),
    protocolVersion: z.string().min(1).max(50).optional(),
    blockId: z.string().min(1).max(50).optional(),
    /** reproducible allocation; random when omitted */
    seed: z.string().min(1).max(100).optional(),
    /** IANA zone that defines the learning day of this session */
    timezone: z.string().min(1).max(64).default("Australia/Brisbane"),
  })
  .strict();
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const SlotStateSchema = z.enum(["unrevealed", "revealed", "answered", "skipped", "continued"]);
export type SlotState = z.infer<typeof SlotStateSchema>;

export const SlotSummarySchema = z
  .object({
    slotId: z.string(),
    ordinal: z.number().int().min(0),
    format: z.string(),
    dimension: z.enum(["recognition", "correction", "production"]),
    inputPreference: z.enum(["text", "voice"]),
    readingGroupId: z.string().nullable(),
    questionId: z.string().nullable(),
    state: SlotStateSchema,
    attempts: z.number().int().min(0),
    /** latest assessment of the newest attempt, if any: never a fabricated result for pending answers */
    latest: z.object({ verdict: z.string(), confirmation: z.string() }).nullable(),
    /** vocabulary only (D64): this sentence was shown before and is offered again on purpose; absent for every fresh slot */
    repeat: z.object({ reason: z.enum(["missed", "assisted", "review"]) }).strict().optional(),
  })
  .strict();

export const SessionSnapshotSchema = z
  .object({
    sessionId: z.string(),
    status: z.enum(["active", "suspended", "completed", "ended_early"]),
    purpose: z.enum(["practice", "diagnostic", "heldout"]),
    taskCount: z.number().int().positive(),
    timezone: z.string(),
    createdAt: z.string(),
    endedAt: z.string().nullable(),
    progress: z.object({ closed: z.number().int(), total: z.number().int() }).strict(),
    slots: z.array(SlotSummarySchema),
    /** grammar (default, every older session) or vocabulary practice (migration 016) */
    category: z.enum(["grammar", "vocabulary"]).optional(),
  })
  .strict();
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

export const CreateSessionResponseSchema = z.object({ sessionId: z.string(), snapshot: SessionSnapshotSchema }).strict();
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

/** GET /api/v1/sessions/current */
export const CurrentSessionResponseSchema = z
  .object({ session: SessionSnapshotSchema.nullable(), otherActive: z.object({ sessionId: z.string(), category: z.enum(["grammar", "vocabulary"]) }).strict().nullable().optional() })
  .strict();

export const LeaseRequestSchema = z.object({ tabId: z.string().min(1).max(64) }).strict();
export const LeaseResponseSchema = z.object({ leaseToken: z.number().int().positive(), expiresAt: z.string(), heartbeatSeconds: z.number().int() }).strict();

export const RevealRequestSchema = z.object({ slotId: Id, tabId: z.string().min(1).max(64) }).strict();

/** What the learner may see: prompt and options only. Accepted answers, rubric, explanation and hints are never in this payload. */
export const PromptSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("choice"), prompt_en: z.string(), options: z.array(z.object({ id: z.string(), text: z.string() })), multiple: z.boolean() }),
  z.object({ kind: z.literal("segments"), prompt_en: z.string(), sentence: z.string(), segments: z.array(z.object({ id: z.string(), text: z.string() })), noMistakeId: z.string() }),
  z.object({ kind: z.literal("short"), prompt_en: z.string(), cue_ru: z.string(), max_words: z.number().int(), allow_voice: z.boolean() }),
  z.object({
    kind: z.literal("reading"),
    prompt_en: z.string(),
    paragraphs: z.array(z.string()),
    question: z.object({ id: z.string(), prompt: z.string(), options: z.array(z.object({ id: z.string(), text: z.string() })) }),
  }),
]);
export type Prompt = z.infer<typeof PromptSchema>;

export const RevealResponseSchema = z
  .object({
    slotId: z.string(),
    ordinal: z.number().int(),
    format: z.string(),
    dimension: z.string(),
    inputPreference: z.enum(["text", "voice"]),
    questionId: z.string().nullable(),
    readingGroupId: z.string().nullable(),
    prompt: PromptSchema,
    hintsAvailable: z.number().int().min(0),
    /** true when this slot was already revealed (resume): nothing new was exposed */
    alreadyRevealed: z.boolean(),
    state: SlotStateSchema,
  })
  .strict();
export type RevealResponse = z.infer<typeof RevealResponseSchema>;

export const FeedbackResponseSchema = z
  .object({
    slotId: z.string(),
    /** confirmed = deterministic and certain; pending = saved, to be analysed later; closed = not shown yet */
    state: z.enum(["confirmed", "pending", "closed", "skipped"]),
    verdict: z.string().nullable(),
    confirmation: z.string().nullable(),
    explanation_ru: z.string().nullable(),
    aiReview: z.object({
      judgement: z.enum(["acceptable", "incorrect_candidate", "ambiguous", "abstain"]),
      explanation_ru: z.string(),
      findings: z.array(z.object({ original: z.string(), suggestion: z.string(), explanation_ru: z.string() })),
    }).strict().optional(),
    /** D65: a decided local-AI verdict (correct / incorrect): shown at once as "checked by AI", counted provisionally, never confirmed */
    aiChecked: z.boolean().optional(),
    /** D65: the AI check ended without a verdict (abstain, ambiguous, invalid, failed): the answer waits in the review queue */
    unresolved: z.boolean().optional(),
    correct: z
      .object({
        options: z.array(z.string()).optional(),
        segments: z.array(z.string()).optional(),
        noMistake: z.boolean().optional(),
        corrections: z.array(z.string()).optional(),
        /** the corrected wording of the faulty segment alone (derived from a full-sentence correction), when it can be told */
        fixes: z.array(z.string()).optional(),
        answers: z.array(z.string()).optional(),
      })
      .nullable(),
    message: z.string(),
    /** the task as it was asked (so a block review can show question next to answer) */
    prompt: z.string().nullable().optional(),
    /** the learner's FIRST answer as text (what the summary counts); absent while feedback is closed */
    yourAnswer: z.string().nullable().optional(),
    /** D64: the construction is right but a name/number differs from the approved sentence (counted for the construction, shown as a slip) */
    detail: z
      .object({ approved: z.string(), tokens: z.array(z.object({ text: z.string(), differs: z.boolean() }).strict()), expected: z.array(z.string()) })
      .strict()
      .optional(),
    /** vocabulary practice: the tested word and, for a choice, why each option is or is not the best one here (after the answer only) */
    vocabulary: z
      .object({
        lemma: z.string(),
        family: z.enum(["recognition", "guided_recall", "collocation"]),
        partOfSpeech: z.string(),
        /** the word in Russian: your own text or the AI draft from the dictionary, else the reviewed one from the exercise */
        translationRu: z.string().nullable(),
        translationSource: z.enum(["user", "ai_draft", "exercise"]).nullable(),
        /** the finished sentence split at the gap, and the tested form, so the page can colour the word; the Russian sentence when reviewed */
        sentence: z.object({ before: z.string(), filled: z.string(), after: z.string(), form: z.string() }).strict().nullable(),
        sentenceRu: z.string().nullable(),
        wordRu: z.string().nullable(),
        options: z.array(z.object({ text: z.string(), rationaleRu: z.string(), correct: z.boolean(), chosen: z.boolean() }).strict()),
      })
      .strict()
      .optional(),
  })
  .strict();
export type FeedbackResponse = z.infer<typeof FeedbackResponseSchema>;

export const FinishRequestSchema = z.object({ mode: z.enum(["completed", "ended_early"]) }).strict();

export const SessionSummarySchema = z
  .object({
    sessionId: z.string(),
    status: z.enum(["completed", "ended_early"]),
    total: z.number().int(),
    /** first attempts only; assisted attempts are listed apart and are not unaided evidence */
    counts: z
      .object({
        correct: z.number().int(),
        incorrect: z.number().int(),
        idk: z.number().int(),
        assisted: z.number().int(),
        pending: z.number().int(),
        skipped: z.number().int(),
        unanswered: z.number().int(),
      })
      .strict(),
    pendingAnalysis: z.number().int(),
    /** D65: first attempts decided by the local AI (provisional, "AI-checked"), and answers that could not be checked automatically (unresolved) */
    aiChecked: z.object({ correct: z.number().int(), incorrect: z.number().int() }).strict().optional(),
    unresolved: z.number().int().optional(),
    /** TASK_021: written answers whose local AI check has not produced its draft yet (a live counter; the draft itself never counts as confirmed) */
    aiWaiting: z.number().int().optional(),
    /** D64: first attempts counted as correct whose name/number differs from the approved sentence (a subset of counts.correct) */
    detailDiffers: z.number().int().optional(),
    /** D68: slots that were labelled repeats (practice only; they never count as independent evidence for skill levels) */
    repeats: z.number().int().optional(),
    /** vocabulary sessions: the session category, the activity XP it earned and the words whose first try was wrong or "I don't know" */
    category: z.enum(["grammar", "vocabulary"]).optional(),
    xpEarned: z.number().int().optional(),
    practiseAgain: z.array(z.string()).optional(),
    notes: z.array(z.string()),
  })
  .strict();
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const DeficitSchema = z.object({ kind: z.string(), format: z.string().optional(), needed: z.number().optional(), available: z.number().optional(), message: z.string() });

/** 409 CONTENT_SHORTAGE `details` */
export const ShortageDetailsSchema = z.object({ deficits: z.array(DeficitSchema), largestFeasibleN: z.number().int().nullable(), requestedN: z.number().int() });
export type ShortageDetails = z.infer<typeof ShortageDetailsSchema>;

/** A lesson is played at most this many times (completed sessions); the next lesson comes from the new statistics. */
export const MAX_LESSON_PLAYS = 2;

export const BlueprintListItemSchema = z
  .object({
    blueprintRevisionId: z.string(),
    key: z.string(),
    title: z.string(),
    status: z.string(),
    readySessions: z.number().int(),
    completed: z.number().int().nonnegative(),
    unlocked: z.boolean(),
    shortage: ShortageDetailsSchema.nullable(),
  })
  .strict();

export const DashboardSchema = z
  .object({
    activeSessionId: z.string().nullable(),
    taskCount: z.number().int(),
    blueprints: z.array(BlueprintListItemSchema),
    /** the app-wide state of the non-release slice bank, when applicable */
    banner: z.string().nullable(),
    /** optional starting diagnostic (3 blocks of 8) and delayed held-out checks (TASK_013) */
    diagnostic: z
      .object({ protocol: z.string(), blocksTotal: z.number().int(), blocksUsed: z.number().int(), nextBlock: z.number().int().nullable(), ready: z.boolean(), shortage: z.object({ deficits: z.unknown() }).nullable() })
      .strict(),
    /** D65: answers the local AI could not settle; `notice` once their number reaches the setting reviewNoticeThreshold */
    review: z.object({ unresolved: z.number().int(), threshold: z.number().int(), notice: z.boolean() }).strict().optional(),
    heldout: z
      .object({ protocol: z.string(), availableTasks: z.number().int(), eligibleSkills: z.number().int(), minDelayDays: z.number().int(), ready: z.boolean(), reason: z.string().nullable() })
      .strict(),
  })
  .strict();
export type Dashboard = z.infer<typeof DashboardSchema>;
