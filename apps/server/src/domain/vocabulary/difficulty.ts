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
  for (const [lemma, events] of wordEvents(db)) out.set(lemma, learningFactor(events, learnedByLemma.get(lemma) ?? false));
  return out;
}
