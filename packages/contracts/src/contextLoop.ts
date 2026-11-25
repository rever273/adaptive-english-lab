/** Context Loop (TASK_037): a word recalled inside short ready-made sentences. Sentences are written ahead of time in Content Studio. */

/** sentences per word in one batch (user decision 2026-11-23: up to 15; migration 059) */
export const CONTEXT_LOOP_PER_WORD = { min: 3, max: 15, default: 4 } as const;
export const CONTEXT_LOOP_WORDS = { min: 1, max: 30, default: 10 } as const;
/** a word is playable with two usable sentences (a second context) and "ready" with three */
export const CONTEXT_LOOP_PLAYABLE = 2;
export const CONTEXT_LOOP_READY = 3;

export type ContextLoopSentenceStatus = "validated" | "approved" | "flagged" | "rejected";
export type ContextLoopDifficulty = "easy" | "medium" | "challenging";

export interface ContextLoopCoverage {
  /** words with at least CONTEXT_LOOP_READY usable sentences */
  ready: number;
  /** words with at least CONTEXT_LOOP_PLAYABLE usable sentences (they can be practised) */
  playable: number;
  /** words that cannot be practised yet */
  missing: number;
  /** words with sentences written for an older translation */
  stale: number;
  /** words not marked learned that have a translation */
  eligible: number;
}

export interface ContextLoopBatchView {
  id: string;
  author: "model" | "agent";
  status: "generating" | "awaiting_agent" | "done" | "failed";
  words: number;
  perWord: number;
  errorCode: string | null;
  receipt: { accepted: number; flagged: number; rejected: number } | null;
  sentences: number;
  createdAt: string;
}

export interface ContextLoopStudioStatus {
  coverage: ContextLoopCoverage;
  candidates: number;
  generating: number;
  flagged: number;
  batches: ContextLoopBatchView[];
  defaults: { words: number; perWord: number };
  limits: { words: { min: number; max: number }; perWord: { min: number; max: number } };
}

export interface ContextLoopSentenceView {
  id: string;
  entryId: string;
  lemma: string;
  text: string;
  targetStart: number;
  targetLength: number;
  contextLabel: string;
  difficulty: ContextLoopDifficulty;
  source: "model" | "agent" | "learner";
  status: ContextLoopSentenceStatus;
  reason: string | null;
  stale: boolean;
  createdAt: string;
}

export interface ContextLoopStatus {
  playableWords: number;
  readyWords: number;
  missingWords: number;
  activeSessionId: string | null;
}

export interface ContextLoopAids {
  wordAudio?: boolean;
  sentenceAudio?: boolean;
  translation?: boolean;
}

export interface ContextLoopCard {
  cardIndex: number;
  kind: "card";
  entryId: string;
  lemma: string;
  /** translationRu: written and reviewed with the sentence; null for older sentences (the learner may still ask for a translation) */
  sentence: { id: string; text: string; targetStart: number; targetLength: number; translationRu: string | null };
  meaning: { translationRu: string; definitionRu: string; pos: string };
  /** the same sentence as an earlier encounter of this session (a labelled repeat) */
  sameSentenceAgain: boolean;
  /** a later encounter of the word in a sentence not seen in this session */
  newContext: boolean;
  encounter: number;
}

/** D159: the rare check. The English word is NOT sent: only the familiar sentence with a gap, the Russian meaning and the part of speech. */
export interface ContextLoopCheckCard {
  cardIndex: number;
  kind: "check";
  gapped: string;
  cue: { translationRu: string; pos: string };
  encounter: number;
  /** speech recognition is available for a spoken answer */
  voice: boolean;
}

export type ContextLoopCheckOutcome = "correct" | "incorrect" | "synonym" | "skipped";

/** the result of the check just answered (shown until the learner continues) */
export interface ContextLoopCheckResult {
  cardIndex: number;
  outcome: ContextLoopCheckOutcome;
  formMatch: "exact" | "other_form" | null;
  answer: string | null;
  expected: string;
  lemma: string;
  sentence: string;
}

export interface ContextLoopSummary {
  cards: number;
  words: number;
  firstTry: number;
  newContextSuccess: number;
  checks: { correct: number; total: number };
  returns: number;
  needsWork: string[];
  /** per word in the order met: recalled or typed right vs missed (a skipped check is neither); done = closed in this session */
  perWord: Array<{ lemma: string; success: number; miss: number; done: boolean }>;
}

export interface ContextLoopState {
  sessionId: string;
  status: "active" | "completed";
  finished: boolean;
  card: ContextLoopCard | ContextLoopCheckCard | null;
  lastCheck: ContextLoopCheckResult | null;
  progress: { cards: number; maxCards: number; wordsDone: number; wordsTotal: number };
  summary: ContextLoopSummary;
}
