/**
 * context-loop-queue-v1 (TASK_037 §5.2): the order of cards inside one session, as a pure function of the stored plan and the answers so far.
 * No clock and no database: the same plan and answers always give the same next card, so pausing, reloading or a lost reply cost nothing.
 */
export const CONTEXT_LOOP_QUEUE_VERSION = "context-loop-queue-v1";

export const QUEUE_DEFAULTS = {
  /** a word not recalled comes back after at least this many other cards */
  missGap: 3,
  /** a missed word waits 0..missSpread extra cards (a fixed function of the word and its encounter), so two misses in a row do not return in lockstep */
  missSpread: 2,
  /** after the first "recalled" the word is checked in another sentence after this many other cards */
  verifyGap: 8,
  /** the first returns after a miss show the same sentence (to fix the link word - meaning); later ones another sentence */
  sameSentenceMisses: 2,
  /** at most this many encounters of one word per session */
  maxEncounters: 5,
  /** the most different words in one session */
  maxWords: 8,
  maxCards: 20,
} as const;

export interface QueueParams {
  missGap: number;
  /** absent in plans stored before it existed: those keep the fixed gap */
  missSpread?: number;
  verifyGap: number;
  sameSentenceMisses: number;
  maxEncounters: number;
  maxCards: number;
}

export interface PlanWord {
  entryId: string;
  lemma: string;
  /** the word was in review (several spaced successes) before this session: one success in a new sentence closes it */
  wasReview: boolean;
  /** usable sentences in the order to use them; `seen` = shown in an earlier session */
  sentences: Array<{ id: string; seen: boolean }>;
  meaning: { translationRu: string; definitionRu: string; pos: string };
  /** D159: this word gets one typed/spoken check (the sentence the learner recalled on an earlier day, with the word hidden) */
  check?: { sentenceId: string } | null;
}

export interface SessionPlan {
  version: typeof CONTEXT_LOOP_QUEUE_VERSION;
  params: QueueParams;
  words: PlanWord[];
}

export type CardOutcome = "recalled" | "not_recalled" | "correct" | "incorrect" | "synonym" | "skipped";
export interface QueueAttempt {
  cardIndex: number;
  entryId: string;
  sentenceId: string;
  outcome: CardOutcome;
}

export interface NextCard {
  cardIndex: number;
  kind: "card" | "check";
  word: PlanWord;
  sentenceId: string;
  encounter: number;
  /** this sentence was already shown in this session (a labelled repeat) */
  sameInSession: boolean;
  /** never shown to the learner before, in any session */
  newContext: boolean;
}

const success = (o: CardOutcome) => o === "recalled" || o === "correct";
export const isCheck = (o: CardOutcome) => o === "correct" || o === "incorrect" || o === "synonym" || o === "skipped";

interface WordRun {
  word: PlanWord;
  order: number;
  attempts: QueueAttempt[];
}

function runs(plan: SessionPlan, attempts: readonly QueueAttempt[]): WordRun[] {
  return plan.words.map((word, order) => ({ word, order, attempts: attempts.filter((a) => a.entryId === word.entryId).sort((a, b) => a.cardIndex - b.cardIndex) }));
}

/** a word is closed after two successes, after one success in a new sentence when it was already in review, or after the maximum of encounters */
export function closed(r: WordRun, p: QueueParams): boolean {
  const ok = r.attempts.filter((a) => success(a.outcome));
  if (ok.length >= 2) return true;
  if (ok.length === 1 && r.word.wasReview) {
    const s = r.word.sentences.find((x) => x.id === ok[0]!.sentenceId);
    const firstUse = r.attempts.findIndex((a) => a.sentenceId === ok[0]!.sentenceId) === r.attempts.indexOf(ok[0]!);
    if (s && !s.seen && firstUse) return true;
  }
  return r.attempts.length >= p.maxEncounters;
}

function sentenceFor(r: WordRun, p: QueueParams): string | null {
  const used = r.attempts.map((a) => a.sentenceId);
  const last = r.attempts[r.attempts.length - 1];
  const inPlan = (id: string) => r.word.sentences.some((s) => s.id === id);
  if (last && last.outcome === "not_recalled" && inPlan(last.sentenceId) && used.filter((id) => id === last.sentenceId).length <= p.sameSentenceMisses) return last.sentenceId;
  // the sentence kept for this word's check is not shown filled in before the check (unless it is the only one left)
  const pendingCheck = r.word.check && !r.attempts.some((a) => isCheck(a.outcome)) ? r.word.check.sentenceId : null;
  const fresh = r.word.sentences.find((s) => !used.includes(s.id) && s.id !== pendingCheck) ?? r.word.sentences.find((s) => !used.includes(s.id));
  if (fresh) return fresh.id;
  // every sentence of the word was shown in this session: the one shown longest ago comes back as a labelled repeat
  const lastUse = (id: string) => Math.max(...r.attempts.filter((a) => a.sentenceId === id).map((a) => a.cardIndex));
  const byAge = [...new Set(used)].filter((id) => id !== last?.sentenceId && inPlan(id)).sort((a, b) => lastUse(a) - lastUse(b));
  return byAge[0] ?? (last && inPlan(last.sentenceId) ? last.sentenceId : null);
}

/** 0..max extra cards, the same for the same word and encounter (FNV-1a), so the queue stays a pure function of the plan and answers */
function fnv(key: string): number {
  let h = 0x811c9dc5;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}
function spread(entryId: string, encounter: number, max: number): number {
  return max > 0 ? fnv(`${entryId}:${encounter}`) % (max + 1) : 0;
}

export function nextCard(plan: SessionPlan, attempts: readonly QueueAttempt[]): NextCard | null {
  const p = plan.params;
  const cardIndex = attempts.length;
  if (cardIndex >= p.maxCards) return null;
  const all = runs(plan, attempts);
  const open = all.filter((r) => !closed(r, p) && r.word.sentences.length > 0);
  const started = open.filter((r) => r.attempts.length > 0);
  const allowed = (r: WordRun) => {
    const last = r.attempts[r.attempts.length - 1]!;
    return last.cardIndex + (success(last.outcome) ? p.verifyGap : p.missGap + spread(r.word.entryId, r.attempts.length, p.missSpread ?? 0)) + 1;
  };
  // words due at the same card: with a spread, the tie is broken by a fixed shuffle for this card, not by the plan order
  const tie = (r: WordRun) => (p.missSpread ? fnv(`${r.word.entryId}@${cardIndex}`) : r.order);
  const byAllowed = (a: WordRun, b: WordRun) => allowed(a) - allowed(b) || tie(a) - tie(b) || a.order - b.order;
  const lastEntry = attempts.length > 0 ? [...attempts].sort((a, b) => b.cardIndex - a.cardIndex)[0]!.entryId : null;
  let pick = started.filter((r) => allowed(r) <= cardIndex).sort(byAllowed)[0];
  pick ??= open.find((r) => r.attempts.length === 0);
  // nothing due and no new word: the nearest return comes early, but never the same word twice in a row unless it is the only one left
  pick ??= started.filter((r) => r.word.entryId !== lastEntry).sort(byAllowed)[0];
  pick ??= started.length === 1 ? started[0] : undefined;
  if (!pick) return null;
  // the check in a new context of a word marked for it becomes the rare typed/spoken check (once per word)
  const lastOfPick = pick.attempts[pick.attempts.length - 1];
  const checkDone = pick.attempts.some((a) => isCheck(a.outcome));
  if (pick.word.check && lastOfPick && success(lastOfPick.outcome) && !checkDone) {
    const sentenceId = pick.word.check.sentenceId;
    return { cardIndex, kind: "check", word: pick.word, sentenceId, encounter: pick.attempts.length + 1, sameInSession: pick.attempts.some((a) => a.sentenceId === sentenceId), newContext: false };
  }
  const sentenceId = sentenceFor(pick, p);
  if (!sentenceId) return null;
  const sameInSession = pick.attempts.some((a) => a.sentenceId === sentenceId);
  const seen = pick.word.sentences.find((s) => s.id === sentenceId)?.seen ?? true;
  return { cardIndex, kind: "card", word: pick.word, sentenceId, encounter: pick.attempts.length + 1, sameInSession, newContext: !seen && !sameInSession };
}

export interface QueueSummary {
  cards: number;
  wordsDone: number;
  wordsStarted: number;
  firstTry: number;
  newContextSuccess: number;
  returns: number;
  needsWork: string[];
  /** per word in the order met: successes (recalled / typed right) and misses; a skipped check counts as neither */
  perWord: Array<{ lemma: string; success: number; miss: number; done: boolean }>;
}

export function summarise(plan: SessionPlan, attempts: readonly QueueAttempt[]): QueueSummary {
  const all = runs(plan, attempts);
  const started = all.filter((r) => r.attempts.length > 0);
  let newContextSuccess = 0;
  for (const r of started) {
    r.attempts.forEach((a, i) => {
      if (i > 0 && success(a.outcome) && !r.attempts.slice(0, i).some((b) => b.sentenceId === a.sentenceId)) newContextSuccess++;
    });
  }
  return {
    cards: attempts.length,
    wordsDone: all.filter((r) => closed(r, plan.params)).length,
    wordsStarted: started.length,
    firstTry: started.filter((r) => success(r.attempts[0]!.outcome)).length,
    newContextSuccess,
    returns: started.reduce((n, r) => n + r.attempts.length - 1, 0),
    needsWork: started.filter((r) => !success(r.attempts[r.attempts.length - 1]!.outcome) || !r.attempts.some((a) => success(a.outcome))).map((r) => r.word.lemma),
    perWord: [...started]
      .sort((a, b) => a.attempts[0]!.cardIndex - b.attempts[0]!.cardIndex)
      .map((r) => ({ lemma: r.word.lemma, success: r.attempts.filter((a) => success(a.outcome)).length, miss: r.attempts.filter((a) => !success(a.outcome) && a.outcome !== "skipped").length, done: closed(r, plan.params) })),
  };
}
