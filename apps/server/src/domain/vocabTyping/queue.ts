/**
 * The queue of a Learning session (D168), a pure function of the stored plan, the answers so far and the sentences hidden since (like
 * `contextLoop/queue.ts`). Nothing about the queue is stored as state: re-running the function on the same inputs gives the same next card.
 *
 *  - order: due checks, then words being learned that were met before, then new words (the plan fixes it);
 *  - "Still learning" brings a word back after at least `gap` other cards, in another sentence if there is one, at most `maxShows` times a session;
 *  - "Learned" removes the word from this session;
 *  - a failed check turns the word into a learning card at the end of the queue (never a second check in the same session);
 *  - with fewer words than the gap the word may return sooner (it cannot be kept out of a short queue).
 */
export const LEARN_QUEUE_VERSION = "vt-learn-v1";
export const QUEUE_DEFAULTS = { gap: 3, maxShows: 4 } as const;

export interface PlanSentence {
  id: string;
  /** shown for this word in an earlier session (D64/D68: not new evidence; used last and labelled) */
  seenBefore: boolean;
}
export interface PlanWord {
  lemma: string;
  kind: "check" | "learn";
  /** never typed in a sentence before */
  isNew: boolean;
  sentences: PlanSentence[];
}
export interface LearnPlan {
  version: string;
  params: { maxCards: number; gap: number; maxShows: number };
  words: PlanWord[];
}

export type AnswerKind = "learned" | "still" | "check_pass" | "check_fail" | "check_skipped";
export interface Answer {
  cardIndex: number;
  lemma: string;
  sentenceId: string;
  kind: AnswerKind;
}

export interface NextCard {
  cardIndex: number;
  kind: "check" | "learn";
  word: PlanWord;
  sentenceId: string;
  seenBefore: boolean;
  /** which showing of the word as a learning card this is (1-based) */
  show: number;
}

interface WordState {
  word: PlanWord;
  order: number;
  /** learning cards answered */
  shows: number;
  /** index of the last answered card of this word */
  last: number;
  done: boolean;
  /** has to be shown as a learning card (a failed check) */
  relearn: boolean;
  checked: boolean;
  used: string[];
}

const pairKey = (lemma: string, sentenceId: string): string => `${lemma}:${sentenceId}`;

/** `hidden` holds `lemma:sentenceId` pairs the learner flagged (or that were hidden otherwise) after the plan was made */
export function nextCard(plan: LearnPlan, answers: readonly Answer[], hidden: ReadonlySet<string> = new Set()): NextCard | null {
  const cardIndex = answers.length;
  if (cardIndex >= plan.params.maxCards) return null;
  const states = new Map<string, WordState>(plan.words.map((word, order) => [word.lemma, { word, order, shows: 0, last: -1, done: false, relearn: false, checked: false, used: [] }]));
  let appended = plan.words.length;
  for (const a of answers) {
    const s = states.get(a.lemma);
    if (!s) continue;
    s.last = a.cardIndex;
    s.used.push(a.sentenceId);
    if (a.kind === "learned") s.done = true;
    else if (a.kind === "still") {
      s.shows++;
      if (s.shows >= plan.params.maxShows) s.done = true;
    } else if (a.kind === "check_pass" || a.kind === "check_skipped") {
      s.checked = true;
      s.done = true;
    } else {
      // check_fail: back to learning, behind everything else
      s.checked = true;
      s.relearn = true;
      s.order = appended++;
    }
  }
  const usable = (s: WordState): PlanSentence[] => s.word.sentences.filter((x) => !hidden.has(pairKey(s.word.lemma, x.id)));
  const open = [...states.values()].filter((s) => !s.done && usable(s).length > 0).sort((a, b) => a.order - b.order);
  if (open.length === 0) return null;
  // returns (a word met in this session) are eligible after `gap` other cards; a word that was never shown is always eligible
  const waited = (s: WordState): number => cardIndex - s.last - 1;
  const eligible = open.filter((s) => s.last < 0 || waited(s) >= plan.params.gap);
  const returning = eligible.filter((s) => s.last >= 0).sort((a, b) => a.last - b.last);
  let pick: WordState | undefined = returning[0] ?? eligible[0];
  if (!pick) {
    // everything left is still cooling down (a short queue): the word that has waited longest, never the card just answered unless it is the only one
    const others = open.filter((s) => s.last !== cardIndex - 1);
    pick = (others.length > 0 ? others : open).sort((a, b) => a.last - b.last)[0];
  }
  if (!pick) return null;
  const isCheck = pick.word.kind === "check" && !pick.checked;
  const options = usable(pick);
  // another sentence than any shown in this session when there is one; otherwise the one shown longest ago
  const fresh = options.filter((x) => !pick!.used.includes(x.id));
  const chosen = fresh[0] ?? [...options].sort((a, b) => pick!.used.lastIndexOf(a.id) - pick!.used.lastIndexOf(b.id))[0]!;
  return { cardIndex, kind: isCheck ? "check" : "learn", word: pick.word, sentenceId: chosen.id, seenBefore: chosen.seenBefore, show: pick.shows + 1 };
}

export interface QueueSummary {
  cards: number;
  learned: number;
  stillLearning: number;
  checksPassed: number;
  checksFailed: number;
}

export function summarise(answers: readonly Answer[]): QueueSummary {
  const learned = new Set(answers.filter((a) => a.kind === "learned").map((a) => a.lemma));
  const still = new Set(answers.filter((a) => a.kind === "still" || a.kind === "check_fail").map((a) => a.lemma));
  return {
    cards: answers.length,
    learned: learned.size,
    stillLearning: [...still].filter((l) => !learned.has(l)).length,
    checksPassed: answers.filter((a) => a.kind === "check_pass").length,
    checksFailed: answers.filter((a) => a.kind === "check_fail").length,
  };
}
