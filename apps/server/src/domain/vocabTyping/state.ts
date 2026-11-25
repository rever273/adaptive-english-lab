/**
 * The state of a word in Vocabulary Typing (D168, TASK_038 section 4.1): never stored, always replayed from the raw facts of the word in time order.
 * A self-assessment (screening Tab, "Learned") is only ever a claim; only a passed cloze check makes a word `verified`.
 */
import type { VtWordState } from "@english-lab/contracts";
export type { VtWordState };

export type VtFactKind =
  | "screen_known"
  | "screen_unknown"
  | "screen_not_useful"
  | "restore"
  | "learn_exposure"
  | "learn_learned"
  | "review_good"
  | "review_again"
  /** a skipped (bad example) check: no rating, no change */
  | "review_skipped";

export interface VtFact {
  kind: VtFactKind;
  /** ISO time of the fact */
  at: string;
  /** the learning day of the fact (local_date of the raw row) */
  date: string;
}

export const VT_STATES: readonly VtWordState[] = ["unscreened", "known_screening", "excluded_by_learner", "learning", "awaiting_verification", "verified"];

export function nextState(state: VtWordState, kind: VtFactKind): VtWordState {
  switch (kind) {
    case "screen_known":
      return state === "unscreened" ? "known_screening" : state;
    case "screen_unknown":
      return state === "unscreened" ? "learning" : state;
    case "screen_not_useful":
      return state === "unscreened" ? "excluded_by_learner" : state;
    case "restore":
      return state === "excluded_by_learner" ? "unscreened" : state;
    case "learn_exposure":
      return state;
    case "learn_learned":
      return state === "learning" ? "awaiting_verification" : state;
    case "review_good":
      return state === "awaiting_verification" || state === "verified" ? "verified" : state;
    case "review_again":
      return state === "awaiting_verification" || state === "verified" ? "learning" : state;
    case "review_skipped":
      return state;
  }
}

/** the facts must be in time order */
export function wordState(facts: readonly VtFact[]): VtWordState {
  return facts.reduce<VtWordState>((s, f) => nextState(s, f.kind), "unscreened");
}

/** the state after each fact, for the day-by-day estimate */
export function stateTimeline(facts: readonly VtFact[]): Array<{ at: string; date: string; state: VtWordState }> {
  let s: VtWordState = "unscreened";
  return facts.map((f) => {
    s = nextState(s, f.kind);
    return { at: f.at, date: f.date, state: s };
  });
}

export interface WordSummary {
  state: VtWordState;
  /** the screening result that counted for the estimate (kept even after the word is learned); null while unscreened */
  originalScreen: "known" | "unknown" | null;
  lastLearnedAt: string | null;
  lastLearnedDate: string | null;
  lapses: number;
  checksPassed: number;
  checksFailed: number;
  /** how many learn cards were answered */
  learnCards: number;
  lastContactAt: string | null;
}

export function summarise(facts: readonly VtFact[]): WordSummary {
  let state: VtWordState = "unscreened";
  const out: WordSummary = { state, originalScreen: null, lastLearnedAt: null, lastLearnedDate: null, lapses: 0, checksPassed: 0, checksFailed: 0, learnCards: 0, lastContactAt: null };
  for (const f of facts) {
    if (f.kind === "restore" && state === "excluded_by_learner") out.originalScreen = null;
    if ((f.kind === "screen_known" || f.kind === "screen_unknown") && state === "unscreened") out.originalScreen = f.kind === "screen_known" ? "known" : "unknown";
    if (f.kind === "learn_learned" && state === "learning") {
      out.lastLearnedAt = f.at;
      out.lastLearnedDate = f.date;
    }
    if (f.kind === "learn_learned" || f.kind === "learn_exposure") out.learnCards++;
    if (f.kind === "review_good" && (state === "awaiting_verification" || state === "verified")) out.checksPassed++;
    if (f.kind === "review_again" && (state === "awaiting_verification" || state === "verified")) {
      out.checksFailed++;
      out.lapses++;
    }
    if (f.kind !== "restore") out.lastContactAt = f.at;
    state = nextState(state, f.kind);
  }
  out.state = state;
  return out;
}

/** a date (YYYY-MM-DD) plus whole days */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
