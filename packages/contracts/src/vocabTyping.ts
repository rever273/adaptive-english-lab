import { z } from "zod";

/** Vocabulary Typing (TASK_038, D163-D174): the fourth Typing block. Screening (stage 1) finds out which words are known; Learning (stage 2) teaches the rest in real sentences. */

export type VtStage = "screening" | "learning";
export type VtWordState = "unscreened" | "known_screening" | "excluded_by_learner" | "learning" | "awaiting_verification" | "verified";
export type VtCheckOutcome = "correct" | "form_match" | "typo" | "incorrect" | "revealed" | "skipped";

/** a bound on the sentence text the learner has to type (Tatoeba filter, D166) */
export const VT_SENTENCE_WORDS = { min: 3, max: 16 } as const;

const id = z.string().min(1).max(64);
const KeyStat = z.object({ pair: z.string().regex(/^[a-z-]{2}$/), count: z.number().int().min(0).max(100000), totalMs: z.number().int().min(0).max(100_000_000), errors: z.number().int().min(0).max(100000) }).strict();
export const VtTypingSchema = z.object({ activeMs: z.number().int().min(0).max(3_600_000), chars: z.number().int().min(0).max(5000), errors: z.number().int().min(0).max(5000), keyStats: z.array(KeyStat).max(400).optional() }).strict();
export type VtTyping = z.infer<typeof VtTypingSchema>;

export const VtStartRequestSchema = z.object({ tabId: id }).strict();
/** a decision of either stage; screening names the word, learning names the card (the server knows the word and the sentence) */
export const VtEventRequestSchema = z
  .object({
    clientEventId: z.string().uuid(),
    tabId: id,
    kind: z.enum(["screen_known", "screen_unknown", "screen_archived", "learn_exposure", "learn_learned"]),
    lemma: z.string().regex(/^[a-z]{2,32}$/).optional(),
    cardIndex: z.number().int().min(0).max(1000).optional(),
    typing: VtTypingSchema,
  })
  .strict()
  .refine((b) => (b.kind.startsWith("screen_") ? Boolean(b.lemma) : b.cardIndex !== undefined), { message: "screening names the word, learning names the card" });
export type VtEventRequest = z.infer<typeof VtEventRequestSchema>;
export const VtReviewRequestSchema = z.object({ clientEventId: z.string().uuid(), tabId: id, cardIndex: z.number().int().min(0).max(1000), text: z.string().max(60).nullable() }).strict();
export type VtReviewRequest = z.infer<typeof VtReviewRequestSchema>;
export const VtFlagRequestSchema = z.object({ clientEventId: z.string().uuid(), tabId: id, cardIndex: z.number().int().min(0).max(1000) }).strict();
export const VtCompleteRequestSchema = z.object({ tabId: id, keyStats: z.array(KeyStat).max(600).optional() }).strict();
export const VtActivityRequestSchema = z.object({ id: z.string().uuid(), tabId: id, startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative() }).strict();

export interface VtWordFacts {
  lemma: string;
  transcription: string;
  translationRu: string;
  pos: string;
}
/** how many following words the screening card carries besides the current one (a batch is at most 40 words: the rest of it is in sight, as a line of words) */
export const SCREENING_LOOKAHEAD = 40;
export interface VtScreeningCard {
  kind: "screen";
  /** position of the word in the session's plan */
  cardIndex: number;
  word: VtWordFacts;
  /** the words that follow, in order (up to `SCREENING_LOOKAHEAD`): they are shown in a row after the current word */
  upcoming: VtWordFacts[];
}
export interface VtLearnCard {
  kind: "learn";
  cardIndex: number;
  word: VtWordFacts;
  sentence: { id: string; text: string; textRu: string; targetStart: number; targetLength: number; seenBefore: boolean };
  /** which showing of the word in this session (1-based) and the most there can be */
  show: number;
  maxShows: number;
}
/** the answer, the word, its translation and the audio stay on the server until the answer is in */
export interface VtCheckCard {
  kind: "check";
  cardIndex: number;
  gapped: string;
  textRu: string;
  pos: string;
}
export type VtCard = VtScreeningCard | VtLearnCard | VtCheckCard;

export interface VtCheckResult {
  cardIndex: number;
  outcome: VtCheckOutcome;
  rating: "good" | "again" | null;
  answer: string | null;
  expected: string;
  lemma: string;
  sentence: string;
  sentenceId: string;
  textRu: string;
  word: VtWordFacts;
}

export interface VtSummary {
  /** screening */
  screened: number;
  known: number;
  unknown: number;
  /** archived by the learner (D184) */
  notUseful: number;
  /** learning */
  cards: number;
  learned: number;
  stillLearning: number;
  checksPassed: number;
  checksFailed: number;
  checksSkipped: number;
}
export interface VtSessionMetrics {
  activeMs: number;
  charsTyped: number;
  errors: number;
  wpm: number;
  accuracy: number | null;
  metricsVersion: string;
}
export interface VtSessionState {
  sessionId: string;
  stage: VtStage;
  status: "active" | "completed" | "abandoned";
  finished: boolean;
  card: VtCard | null;
  lastCheck: VtCheckResult | null;
  progress: { done: number; total: number };
  summary: VtSummary;
  metrics: VtSessionMetrics | null;
  /** the vocabulary estimate right after the session (screening) */
  estimate: VtEstimateView | null;
  /** learning: why there is nothing to do, or when the next check is due */
  empty: { reason: "nothing_to_learn" | "all_done"; nextDue: string | null } | null;
  settings: { speakWord: boolean; speakSentence: boolean };
}

export interface VtEstimateView {
  version: string;
  /** null while fewer than 100 words are screened */
  value: number | null;
  low: number | null;
  high: number | null;
  screened: number;
  probes: number;
  poolSize: number;
  /** the most frequent words skipped by the pool and counted as known by assumption (D177), already inside `value` */
  assumedKnown: number;
}

export interface VtOverview {
  poolSize: number;
  screening: { screened: number; remaining: number; known: number; unknown: number; notUseful: number };
  learning: { learning: number; awaiting: number; verified: number; dueNow: number; noExamples: number; playable: number };
  estimate: VtEstimateView;
  activeSessions: { screening: string | null; learning: string | null };
  /** words (with a rank) are missing: `npm run vtyping:prepare` has not run */
  prepared: boolean;
}

export interface VtWordRow {
  lemma: string;
  rank: number;
  band: number;
  translationRu: string;
  state: VtWordState | "excluded_by_cleanup";
  /** archived in the word bank (by the cleanup or by the learner) */
  archived?: boolean;
  /** a word to learn without a single usable sentence */
  noExamples: boolean;
  contextCount: number;
  nextCheck: string | null;
  lapses: number;
}

export interface VtBandRow {
  band: number;
  pool: number;
  screened: number;
  known: number;
  /** share of known words among the screened (null before the first one) */
  share: number | null;
}

export interface VtAnalytics {
  days: number;
  estimate: VtEstimateView;
  knownNow: { total: number; knownScreening: number; awaiting: number; verified: number };
  newWordsLearned: { selfReported: number; verified: number };
  series: Array<{ date: string; estimate: number | null; knownNow: number }>;
  bands: VtBandRow[];
  excluded: { cleanup: number; learner: number };
  /** per learning day inside the period */
  daily: Array<{ date: string; wpm: number | null; accuracy: number | null; minutes: number; known: number; unknown: number; notUseful: number; learned: number; verified: number }>;
  /** share of passed checks per week */
  weekly: Array<{ week: string; passed: number; failed: number; rate: number | null }>;
  /** checks falling due on each of the next 14 learning days (today first; overdue ones are counted today) */
  dueForecast: Array<{ date: string; count: number }>;
  records: { bestWpm: number | null; bestAccuracy: number | null; mostCards: number; longestMs: number };
  screening: { screened: number; remaining: number; probes: number };
  learning: { learning: number; awaiting: number; verified: number; dueNow: number; dueNext7: number; checksPassed: number; checksFailed: number; returnedToLearning: number; noExamples: number };
  typing: { sessions: number; wpm: number | null; accuracy: number | null; errors: number; activeMs: number; troublePairs: Array<{ pair: string; errorRate: number; count: number }> };
  attribution: string;
}

export const VT_ATTRIBUTION = "Example sentences: Tatoeba (tatoeba.org), CC BY 2.0 FR";

export const VT_WORD_FILTERS = ["unscreened", "known_screening", "learning", "awaiting_verification", "verified", "excluded", "no_examples"] as const;
export type VtWordFilter = (typeof VT_WORD_FILTERS)[number];
