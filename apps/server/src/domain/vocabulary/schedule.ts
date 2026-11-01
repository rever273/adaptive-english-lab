import { createHash } from "node:crypto";

/**
 * vocabulary-selection-v2 (D64, TASK_020): pure, deterministic word scheduling and picking on raw first-attempt outcomes.
 * No database, no clock, no model: the caller supplies events, candidates, `now` and a seed, and the same input gives the same choice.
 * Hints and shown answers are never success; a miss makes the word due at once; a shown sentence may come back as a labelled repeat.
 */
export const VOCABULARY_SELECTION_V2 = "vocabulary-selection-v2";
export const VOCABULARY_SELECTION_V3 = "vocabulary-selection-v3";
export const VOCABULARY_SELECTION_V4 = "vocabulary-selection-v4";
const DAY_MS = 86_400_000;

export type Family = "recognition" | "guided_recall" | "collocation";
/** soft format mix of a session (spec: about 50/30/20); integer rounding and stock decide the rest */
export const FAMILY_WEIGHT: Record<Family, number> = { recognition: 0.5, guided_recall: 0.3, collocation: 0.2 };

/** the algorithm config stored in algorithm_versions (id `vocabulary-selection-v2`) */
export const SELECTION_CONFIG = {
  version: VOCABULARY_SELECTION_V4,
  correctRepeatDays: 3,
  shortageRepeatDays: 1,
  familyWeights: FAMILY_WEIGHT,
  /** days until a word is due again, by success streak (1, 2, 3, 4, 5, 6 and more) */
  intervalDays: { 1: 1, 2: 2, 3: 4, 4: 7, 5: 14, 6: 21 },
  maxIntervalDays: 21,
  maxLearnedIntervalDays: 30,
  minSuccessSpacingHours: 24,
  learnedIntervalFactor: 2,
  assistedDueDays: 1,
  learnedWithoutHistoryStreak: 3,
  recentMissWindow: 3,
  recentMissBoostCap: 3,
  /** repeats may fill at most this share of a session */
  repeatShareCap: 0.6,
  defaultNewWordsPerSession: 4,
  order: "due words by priority, then new words (capped), then not-yet-due words to fill; round-robin by word",
} as const;

export type Outcome = "success" | "miss" | "assisted";
export interface WordEvent {
  at: string;
  outcome: Outcome;
  revisionId: string;
  slotId: string;
  /** Labelled repeats are practice, not independent evidence for interval growth. */
  independent?: boolean;
}

export interface WordState {
  lemma: string;
  state: "new" | "learning" | "review";
  streak: number;
  lastOutcome: Outcome | null;
  lastAt: string | null;
  dueAt: string | null;
  due: boolean;
  intervalDays: number;
  /** (now - lastAt) / interval; 0 when there is no history */
  ratio: number;
  recentMisses: number;
  priority: number;
  lastMissedRevisionId: string | null;
  lastMissedSlotId: string | null;
}

/** days until the next review for a success streak (learned words wait twice as long) */
export function intervalFor(streak: number, learned: boolean): number {
  const t = SELECTION_CONFIG.intervalDays;
  const base = streak <= 0 ? 1 : streak >= 6 ? t[6] : t[streak as 1 | 2 | 3 | 4 | 5];
  return Math.min(learned ? SELECTION_CONFIG.maxLearnedIntervalDays : SELECTION_CONFIG.maxIntervalDays, learned ? base * SELECTION_CONFIG.learnedIntervalFactor : base);
}

/** The state of one word from its independent first-attempt events in time order (pending answers are not events). */
export function wordState(lemma: string, events: readonly WordEvent[], learned: boolean, now: Date): WordState {
  const base = { lemma, lastMissedRevisionId: null, lastMissedSlotId: null, recentMisses: 0, priority: 0 };
  if (events.length === 0) {
    if (!learned) return { ...base, state: "new", streak: 0, lastOutcome: null, lastAt: null, dueAt: null, due: false, intervalDays: 0, ratio: 0 };
    return { ...base, state: "review", streak: SELECTION_CONFIG.learnedWithoutHistoryStreak, lastOutcome: null, lastAt: null, dueAt: null, due: false, intervalDays: intervalFor(SELECTION_CONFIG.learnedWithoutHistoryStreak, true), ratio: 0 };
  }
  let streak = 0;
  let lastAdvance = Number.NEGATIVE_INFINITY;
  let anchor = events[0]!.at;
  for (const e of events) {
    const at = Date.parse(e.at);
    if (e.outcome === "success" && e.independent !== false && at - lastAdvance >= SELECTION_CONFIG.minSuccessSpacingHours * 3_600_000) {
      streak++;
      lastAdvance = at;
      anchor = e.at;
    } else if (e.outcome === "miss") { streak = 0; anchor = e.at; }
    else if (e.outcome === "assisted") anchor = e.at;
  }
  const last = events[events.length - 1]!;
  const recentMisses = events.slice(-SELECTION_CONFIG.recentMissWindow).filter((e) => e.outcome === "miss").length;
  const missed = [...events].reverse().find((e) => e.outcome !== "success") ?? null;
  const lastMs = Date.parse(anchor);
  const elapsedDays = Math.max(0, (now.getTime() - lastMs) / DAY_MS);
  let intervalDays: number;
  let dueAt: string;
  let ratio: number;
  if (last.outcome === "miss") {
    intervalDays = 1; // a miss is due for the next session; the ratio only orders words
    dueAt = anchor;
    ratio = Math.max(1, elapsedDays / intervalDays);
  } else {
    intervalDays = last.outcome === "assisted" ? SELECTION_CONFIG.assistedDueDays * (learned ? SELECTION_CONFIG.learnedIntervalFactor : 1) : intervalFor(streak, learned);
    dueAt = new Date(lastMs + intervalDays * DAY_MS).toISOString();
    ratio = elapsedDays / intervalDays;
  }
  const priority = ratio + Math.min(SELECTION_CONFIG.recentMissBoostCap, recentMisses);
  return {
    ...base,
    state: learned || streak >= 3 ? "review" : "learning",
    streak,
    lastOutcome: last.outcome,
    lastAt: last.at,
    dueAt,
    due: ratio >= 1,
    intervalDays,
    ratio,
    recentMisses,
    priority,
    lastMissedRevisionId: missed?.revisionId ?? null,
    lastMissedSlotId: missed?.slotId ?? null,
  };
}

export interface VocabularyCandidate {
  revisionId: string;
  lemma: string;
  entryId: string;
  learned: boolean;
  family: Family;
  difficulty: string;
  rubricVersion: string;
  units: string[];
  unitFingerprints: string[];
}
/** an approved revision whose sentence was already shown in an earlier vocabulary session (eligible only as a labelled repeat) */
export interface ShownCandidate extends VocabularyCandidate {
  /** units of this revision that are not in the exposure ledger yet (e.g. answer sentences never seen): a repeat slot reserves exactly these */
  unexposedUnits: string[];
  lastShownAt: string;
  lastSlotId: string;
  /** outcome of the last first attempt on this very revision; null when it was only shown or skipped */
  lastOutcome: Outcome | null;
}

export type RepeatReason = "missed" | "assisted" | "review";
export interface VocabularyPick {
  candidate: VocabularyCandidate;
  repeat: { reason: RepeatReason; ofSlotId: string } | null;
  state: WordState;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** small deterministic PRNG so a stored seed reproduces the same choice */
export function rng(seed: string): () => number {
  let h = parseInt(sha256(seed).slice(0, 8), 16) >>> 0;
  return () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PickInput {
  fresh: readonly VocabularyCandidate[];
  shown: readonly ShownCandidate[];
  events: ReadonlyMap<string, readonly WordEvent[]>;
  now: Date;
  n: number;
  seed: string;
  newWordsPerSession: number;
}

/**
 * Pick up to n exercises. Words are ordered: due words (priority = overdue ratio + recent misses), then new words (at most
 * `newWordsPerSession`), then not-yet-due words only to fill; one exercise per word per round. Inside a word: after a miss or help the
 * first choice is a repeat of that sentence; after a success a fresh sentence, and a repeat only when none is left and the word is due.
 * Never the same sentence twice in a session; the 60% repeat share is a soft cap (fresh sentences are preferred beyond it; repeats fill what fresh cannot). Extra new words beyond the cap are used only when the
 * session could not otherwise be filled.
 */
export function pickVocabulary(input: PickInput): VocabularyPick[] {
  const normal = pickVocabularyPass(input, false);
  return normal.length < input.n ? pickVocabularyPass(input, true) : normal;
}

function pickVocabularyPass(input: PickInput, shortage: boolean): VocabularyPick[] {
  const { n, now } = input;
  const rand = rng(input.seed);
  const byRev = (a: VocabularyCandidate, b: VocabularyCandidate) => (a.revisionId < b.revisionId ? -1 : a.revisionId > b.revisionId ? 1 : 0);
  const fresh = new Map<string, VocabularyCandidate[]>();
  for (const c of [...input.fresh].sort(byRev)) (fresh.get(c.lemma) ?? fresh.set(c.lemma, []).get(c.lemma)!).push(c);
  const shown = new Map<string, ShownCandidate[]>();
  for (const c of [...input.shown].sort(byRev)) (shown.get(c.lemma) ?? shown.set(c.lemma, []).get(c.lemma)!).push(c);
  for (const list of fresh.values()) list.sort(() => rand() - 0.5);

  const lemmas = [...new Set([...fresh.keys(), ...shown.keys()])].sort();
  const states = new Map<string, WordState>();
  for (const l of lemmas) {
    const learned = (fresh.get(l)?.[0] ?? shown.get(l)![0]!).learned;
    states.set(l, wordState(l, input.events.get(l) ?? [], learned, now));
  }
  const jitter = new Map(lemmas.map((l) => [l, rand()]));
  const tie = (a: string, b: string) => jitter.get(a)! - jitter.get(b)!;
  const dueWords = lemmas.filter((l) => states.get(l)!.state !== "new" && states.get(l)!.due).sort((a, b) => states.get(b)!.priority - states.get(a)!.priority || tie(a, b));
  const fillWords = lemmas.filter((l) => states.get(l)!.state !== "new" && !states.get(l)!.due).sort((a, b) => states.get(b)!.ratio - states.get(a)!.ratio || tie(a, b));
  const newWords = lemmas.filter((l) => states.get(l)!.state === "new" && ((fresh.get(l)?.length ?? 0) > 0 || (shown.get(l)?.length ?? 0) > 0)).sort((a, b) => Number((fresh.get(b)?.length ?? 0) > 0) - Number((fresh.get(a)?.length ?? 0) > 0) || tie(a, b));
  // Leave room for reviews as backlog grows; reserve at least one new word if available.
  const cap = newWords.length === 0 ? 0 : Math.min(Math.max(1, Math.floor(input.newWordsPerSession)), Math.max(1, n - dueWords.length));
  const newCapped = newWords.slice(0, cap);
  const newExtra = newWords.slice(cap);

  const picked: VocabularyPick[] = [];
  const pickedRevs = new Set<string>();
  const usedUnits = new Set<string>();
  const famCount: Record<string, number> = { recognition: 0, guided_recall: 0, collocation: 0 };
  let repeats = 0;
  let repeatCap = Number.isFinite(n) && n < Number.MAX_SAFE_INTEGER ? Math.floor(SELECTION_CONFIG.repeatShareCap * n) : Number.MAX_SAFE_INTEGER;
  const usable = <T extends VocabularyCandidate>(c: T) => !pickedRevs.has(c.revisionId) && c.unitFingerprints.every((f) => !usedUnits.has(f));

  const take = (c: VocabularyCandidate, st: WordState, repeat: VocabularyPick["repeat"]) => {
    picked.push({ candidate: c, repeat, state: st });
    pickedRevs.add(c.revisionId);
    famCount[c.family]!++;
    for (const f of c.unitFingerprints) usedUnits.add(f);
    if (repeat) repeats++;
  };

  // repeat pool of a word = ANY of its shown sentences: missed, then helped, then skipped/only shown, then answered correctly; oldest shown first
  const klass = (c: ShownCandidate) => (c.lastOutcome === "miss" ? 0 : c.lastOutcome === "assisted" ? 1 : c.lastOutcome === "success" ? 3 : 2);
  const byPool = (a: ShownCandidate, b: ShownCandidate) => klass(a) - klass(b) || (a.lastShownAt < b.lastShownAt ? -1 : a.lastShownAt > b.lastShownAt ? 1 : byRev(a, b));
  const reasonOf = (c: ShownCandidate): RepeatReason => (klass(c) === 0 ? "missed" : c.lastOutcome === "assisted" ? "assisted" : c.lastOutcome === null ? "missed" : "review");
  const takeRepeat = (c: ShownCandidate, st: WordState) => take(c, st, { reason: reasonOf(c), ofSlotId: c.lastSlotId });

  const tryWord = (lemma: string): boolean => {
    const st = states.get(lemma)!;
    const freshList = (fresh.get(lemma) ?? []).filter(usable);
    const pool = (shown.get(lemma) ?? []).filter(usable).sort(byPool);
    const canRepeat = repeats < repeatCap;
    const unresolved = pool.filter((c) => klass(c) < 3); // missed, helped or skipped sentences not yet answered correctly without help
    const lastBad = st.lastOutcome === "miss" || st.lastOutcome === "assisted";
    // after a miss or help, or when a word is due while a missed sentence is still open: that sentence comes back before a fresh one
    if (canRepeat && freshList.length === 0 && unresolved.length > 0 && (st.state === "new" || lastBad || (st.due && klass(unresolved[0]!) <= 1))) {
      takeRepeat(unresolved[0]!, st);
      return true;
    }
    if (freshList.length > 0) {
      const deficit = (f: Family) => FAMILY_WEIGHT[f] * (picked.length + 1) - famCount[f]!;
      take([...freshList].sort((a, b) => deficit(b.family) - deficit(a.family))[0]!, st, null);
      return true;
    }
    // no fresh sentence left: open sentences first, correctly answered ones only when the word is due
    if (canRepeat) {
      const days = shortage ? SELECTION_CONFIG.shortageRepeatDays : SELECTION_CONFIG.correctRepeatDays;
      const r = pool.find((c) => klass(c) < 3 || (now.getTime() - Date.parse(c.lastShownAt) >= days * DAY_MS && !input.fresh.some(usable)));
      if (r) {
        takeRepeat(r, st);
        return true;
      }
    }
    return false;
  };

  const round = (list: readonly string[]): boolean => {
    let progressed = false;
    for (const l of list) {
      if (picked.length >= n) break;
      if (tryWord(l)) progressed = true;
    }
    return progressed;
  };
  const fill = (primary: readonly string[], rest: readonly string[]) => {
    round(primary);
    round(rest);
    while (picked.length < n) {
      const a = round(primary);
      const b = round(rest);
      if (!a && !b) break;
    }
  };
  // One new word remains possible even with a large due backlog; extra new words fill only shortages.
  if (newCapped.length > 0 && dueWords.length >= n) {
    round(dueWords.slice(0, Math.max(0, n - 1)));
    round(newCapped.slice(0, 1));
  }
  fill([...dueWords, ...newCapped], fillWords);
  if (picked.length < n && newExtra.length > 0) fill([...dueWords, ...newCapped, ...newExtra], fillWords);
  // the 60% repeat share is SOFT: it only prefers fresh sentences for the places beyond it; when no fresh sentence is left,
  // repeats (missed/assisted first, then due reviews) fill the remaining places, up to the whole session
  if (picked.length < n) {
    repeatCap = Number.MAX_SAFE_INTEGER;
    fill([...dueWords, ...newCapped, ...newExtra], fillWords);
  }
  return picked;
}
