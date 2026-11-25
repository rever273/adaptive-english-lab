import { vocabTypingSettings } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { loadSettings } from "../sessions/policy.js";
import { POOL_FROM, loadFacts, poolWhere, rng, shuffled } from "./data.js";
import { wordState } from "./state.js";

export const SCREENING_VERSION = "vt-screen-v1";

export interface ScreeningWord {
  lemma: string;
  /** a random word of a thin band, drawn to keep the estimate unbiased; the learner never sees the difference (D173) */
  probe: boolean;
}
export interface ScreeningPlan {
  version: string;
  words: ScreeningWord[];
}

export interface ScreeningInput {
  /** unscreened pool words, most frequent first */
  inOrder: readonly string[];
  /** unscreened pool words by band (probe candidates) */
  bands: ReadonlyMap<number, readonly string[]>;
  /** probes already used per band in earlier sessions */
  probeCounts: ReadonlyMap<number, number>;
  size: number;
  probeShare: number;
  seed: number;
}

/**
 * Pure: `(1 - probeShare)` of the batch are the next unscreened words by frequency; the rest are random words (seeded) of the bands that have had the
 * fewest probes so far. The batch is shuffled so the two kinds cannot be told apart. The same input and seed give the same plan.
 */
export function planScreening(input: ScreeningInput): ScreeningWord[] {
  const rand = rng(input.seed);
  const ordered = input.inOrder.slice(0, input.size);
  const wantProbes = Math.min(input.size, Math.round(input.size * Math.min(0.5, Math.max(0, input.probeShare))));
  const nOrder = Math.min(ordered.length, input.size - wantProbes);
  const chosen = new Set(ordered.slice(0, nOrder));
  const left = new Map<number, string[]>();
  for (const [band, lemmas] of input.bands) {
    const rest = lemmas.filter((l) => !chosen.has(l));
    if (rest.length) left.set(band, shuffled(rest, rand));
  }
  const counts = new Map(input.probeCounts);
  const probes: string[] = [];
  const needed = input.size - nOrder;
  while (probes.length < needed && left.size > 0) {
    let min = Infinity;
    for (const band of left.keys()) min = Math.min(min, counts.get(band) ?? 0);
    const thin = [...left.keys()].filter((b) => (counts.get(b) ?? 0) === min).sort((a, b) => a - b);
    const band = thin[Math.floor(rand() * thin.length)]!;
    const list = left.get(band)!;
    probes.push(list.pop()!);
    if (list.length === 0) left.delete(band);
    counts.set(band, (counts.get(band) ?? 0) + 1);
  }
  const words: ScreeningWord[] = [...ordered.slice(0, nOrder).map((lemma) => ({ lemma, probe: false })), ...probes.map((lemma) => ({ lemma, probe: true }))];
  return shuffled(words, rand);
}

/** the plan for a new screening session from the current state of the pool (null when every word has been screened) */
export function buildScreeningPlan(db: Db, seed: number): { plan: ScreeningPlan; settings: Record<string, number> } | null {
  const s = vocabTypingSettings(loadSettings(db).values);
  const facts = loadFacts(db);
  const taken = new Set<string>();
  for (const [lemma, list] of facts) if (wordState(list) !== "unscreened") taken.add(lemma);
  const rows = db.prepare(`SELECT l.lemma, l.band FROM ${POOL_FROM} WHERE ${poolWhere(db)} ORDER BY l.freq_rank`).all() as Array<{ lemma: string; band: number }>;
  const inOrder: string[] = [];
  const bands = new Map<number, string[]>();
  for (const r of rows) {
    if (taken.has(r.lemma)) continue;
    inOrder.push(r.lemma);
    (bands.get(r.band) ?? bands.set(r.band, []).get(r.band)!).push(r.lemma);
  }
  if (inOrder.length === 0) return null;
  const probeCounts = new Map((db.prepare("SELECT l.band, COUNT(*) AS n FROM vocab_typing_events e JOIN vocab_typing_lexicon l ON l.lemma = e.lemma WHERE e.stage = 'screening' AND e.is_probe = 1 AND e.kind IN ('screen_known','screen_unknown') GROUP BY l.band").all() as Array<{ band: number; n: number }>).map((r) => [r.band, r.n]));
  const words = planScreening({ inOrder, bands, probeCounts, size: s.screeningBatch, probeShare: s.probeShare, seed });
  return { plan: { version: SCREENING_VERSION, words }, settings: { screeningBatch: s.screeningBatch, probeShare: s.probeShare } };
}
