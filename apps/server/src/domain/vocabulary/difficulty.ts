import type { Db } from "../../db/open.js";
import { wordEvents } from "./practice.js";
import type { WordEvent } from "./schedule.js";

/**
 * How hard a saved word currently is for the learner, from his vocabulary practice: a multiplier for how often it should come up elsewhere
 * (Words levels, the recall check). Based on the last five independent first tries: every miss raises it, assisted answers a little, and a
 * word answered cleanly the last three times is shown about half as often. A word never practised is slightly favoured. Pure and derived.
 */
export function learningFactor(events: readonly WordEvent[], learned: boolean): number {
  const last = events.filter((e) => e.independent !== false).slice(-5);
  if (last.length === 0) return learned ? 1 : 1.2;
  const missRate = last.filter((e) => e.outcome === "miss").length / last.length;
  const assistedRate = last.filter((e) => e.outcome === "assisted").length / last.length;
  let factor = 1 + 2 * missRate + 0.5 * assistedRate;
  const lastThree = last.slice(-3);
  if (lastThree.length === 3 && lastThree.every((e) => e.outcome === "success")) factor *= 0.5;
  return Math.round(factor * 100) / 100;
}

/** lemma -> factor for every saved word that has vocabulary-practice history (words without history are not in the map) */
export function learningFactors(db: Db, learnedByLemma: ReadonlyMap<string, boolean>): Map<string, number> {
  const out = new Map<string, number>();
  const weak = matchWeakness(db);
  for (const [lemma, events] of wordEvents(db)) out.set(lemma, Math.round(learningFactor(events, learnedByLemma.get(lemma) ?? false) * (1 + 0.5 * (weak.get(lemma) ?? 0)) * 100) / 100);
  return out;
}

/**
 * lemma -> share (0..1) of its last three matching games in which the word was weak: pairs left unmatched, or two or more wrong pairs.
 * The game is not Mastery evidence; this only raises how often a weak word comes up elsewhere (up to x1.5). Words without a game are not in the map.
 */
export function matchWeakness(db: Db): Map<string, number> {
  const rows = db.prepare("SELECT lemma, needed, matched, wrong FROM vocabulary_match_results ORDER BY created_at, rowid").all() as Array<{ lemma: string; needed: number; matched: number; wrong: number }>;
  const byLemma = new Map<string, boolean[]>();
  for (const r of rows) byLemma.set(r.lemma, [...(byLemma.get(r.lemma) ?? []), r.matched < r.needed || r.wrong >= 2]);
  return new Map([...byLemma].map(([lemma, flags]) => [lemma, flags.slice(-3).filter(Boolean).length / Math.min(3, flags.length)]));
}
