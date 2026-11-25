import { vocabTypingSettings, type VtEstimateView, type VtWordFacts } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { learningDate } from "../journey/calendar.js";
import { loadSettings } from "../sessions/policy.js";
import { estimateVocabulary, type BandInput, type Estimate } from "./estimate.js";
import { summarise, type VtFact, type VtFactKind, type WordSummary } from "./state.js";

export interface Deps {
  now: () => Date;
  newId: () => string;
}

/** words of the mode: the word bank joined with its rank, minus what the cleanup excluded (D164) */
export const POOL_FROM = "typing_word_bank b JOIN vocab_typing_lexicon l ON l.lemma = b.lemma";
export const POOL_OK = "l.eligibility <> 'excluded'";

/**
 * The training pool (D164, D177): not excluded, a lemma of at least `vtMinLength` letters and beyond the `vtSkipTopRanks` most frequent words
 * (those are assumed known). The numbers are validated integers of the settings, so they are written into the SQL text.
 */
export function poolWhere(db: Db): string {
  const s = vocabTypingSettings(loadSettings(db).values);
  return `${POOL_OK} AND b.archived = 0 AND length(b.lemma) >= ${Math.trunc(s.minLength)} AND l.freq_rank > ${Math.trunc(s.skipTopRanks)}`;
}

export const poolLemmas = (db: Db): Set<string> => new Set((db.prepare(`SELECT l.lemma FROM ${POOL_FROM} WHERE ${poolWhere(db)}`).all() as Array<{ lemma: string }>).map((r) => r.lemma));

/** the most frequent words the pool skips: counted as known by assumption in the estimate (D177) */
export function assumedKnown(db: Db): number {
  const s = vocabTypingSettings(loadSettings(db).values);
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${POOL_FROM} WHERE ${POOL_OK} AND b.archived = 0 AND length(b.lemma) >= ? AND l.freq_rank <= ?`).get(Math.trunc(s.minLength), Math.trunc(s.skipTopRanks)) as { n: number }).n;
}

interface RawFact extends VtFact {
  lemma: string;
  order: number;
}

const SCREEN_KIND: Record<string, VtFactKind> = {
  screen_known: "screen_known",
  screen_unknown: "screen_unknown",
  screen_not_useful: "screen_not_useful",
  screen_archived: "screen_not_useful",
  learn_exposure: "learn_exposure",
  learn_learned: "learn_learned",
};

/** every raw fact of every word that has any, in time order (events, cloze checks, restores by the learner) */
export function loadFacts(db: Db): Map<string, VtFact[]> {
  const raw: RawFact[] = [];
  for (const r of db.prepare("SELECT lemma, kind, created_at AS at, local_date AS date, COALESCE(card_index, -1) AS ord FROM vocab_typing_events").all() as Array<{ lemma: string; kind: string; at: string; date: string; ord: number }>)
    raw.push({ lemma: r.lemma, kind: SCREEN_KIND[r.kind]!, at: r.at, date: r.date, order: r.ord });
  for (const r of db.prepare("SELECT lemma, rating, created_at AS at, local_date AS date, card_index AS ord FROM vocab_typing_reviews").all() as Array<{ lemma: string; rating: string | null; at: string; date: string; ord: number }>)
    raw.push({ lemma: r.lemma, kind: r.rating === "good" ? "review_good" : r.rating === "again" ? "review_again" : "review_skipped", at: r.at, date: r.date, order: r.ord });
  for (const r of db.prepare("SELECT lemma, created_at AS at FROM vocab_typing_cleanup WHERE actor = 'learner' AND decision = 'restore'").all() as Array<{ lemma: string; at: string }>)
    raw.push({ lemma: r.lemma, kind: "restore", at: r.at, date: learningDate(Date.parse(r.at)), order: -1 });
  raw.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order));
  const out = new Map<string, VtFact[]>();
  for (const f of raw) {
    const list = out.get(f.lemma) ?? [];
    list.push({ kind: f.kind, at: f.at, date: f.date });
    out.set(f.lemma, list);
  }
  return out;
}

export function summaries(facts: Map<string, VtFact[]>): Map<string, WordSummary> {
  return new Map([...facts].map(([lemma, f]) => [lemma, summarise(f)]));
}

/** the card facts of a word: lexicon translation first (D165), else the word bank's */
export function wordFacts(db: Db, lemma: string): VtWordFacts {
  const r = db
    .prepare("SELECT b.lemma, b.transcription, b.part_of_speech AS pos, COALESCE(l.primary_translation_ru, b.translation_ru) AS translationRu FROM typing_word_bank b LEFT JOIN vocab_typing_lexicon l ON l.lemma = b.lemma WHERE b.lemma = ?")
    .get(lemma) as VtWordFacts | undefined;
  return r ?? { lemma, transcription: "", translationRu: "", pos: "" };
}

/** the screening events that decided a word, with the probe flag (for the estimate) */
function probeFlags(db: Db): Map<string, boolean> {
  const m = new Map<string, boolean>();
  for (const r of db.prepare("SELECT lemma, is_probe AS p FROM vocab_typing_events WHERE stage = 'screening' AND kind IN ('screen_known','screen_unknown') ORDER BY created_at").all() as Array<{ lemma: string; p: number }>) m.set(r.lemma, r.p === 1);
  return m;
}

/** words of the pool per band (cleanup-excluded words are not in it) */
export function poolByBand(db: Db): Map<number, number> {
  return new Map((db.prepare(`SELECT l.band, COUNT(*) AS n FROM ${POOL_FROM} WHERE ${poolWhere(db)} GROUP BY l.band`).all() as Array<{ band: number; n: number }>).map((r) => [r.band, r.n]));
}

export function bandOfLemmas(db: Db): Map<string, number> {
  return new Map((db.prepare("SELECT lemma, band FROM vocab_typing_lexicon").all() as Array<{ lemma: string; band: number }>).map((r) => [r.lemma, r.band]));
}

/**
 * The inputs of `vt-estimate-v2` as they stood at the end of a learning day (or now, without `upTo`). Learner-excluded words leave the pool; the
 * screening result that counts is the original one.
 */
export function bandInputs(db: Db, facts: Map<string, VtFact[]>, upTo?: string): BandInput[] {
  const pool = new Map(poolByBand(db));
  const bands = bandOfLemmas(db);
  const probes = probeFlags(db);
  const rows = new Map<number, BandInput>();
  const row = (b: number): BandInput => {
    let r = rows.get(b);
    if (!r) {
      r = { band: b, pool: pool.get(b) ?? 0, known: 0, unknown: 0, probeKnown: 0, probeUnknown: 0 };
      rows.set(b, r);
    }
    return r;
  };
  for (const b of pool.keys()) row(b);
  // only words of the pool count: removed, excluded, short and skipped top words are outside it (and outside the denominators)
  const inPool = poolLemmas(db);
  for (const [lemma, list] of facts) {
    const band = bands.get(lemma);
    if (band === undefined || !inPool.has(lemma)) continue;
    const s = summarise(upTo ? list.filter((f) => f.date <= upTo) : list);
    if (s.state === "excluded_by_learner") continue;
    const r = row(band);
    const probe = probes.get(lemma) === true;
    if (s.originalScreen === "known") {
      r.known++;
      if (probe) r.probeKnown++;
    } else if (s.originalScreen === "unknown") {
      r.unknown++;
      if (probe) r.probeUnknown++;
    }
  }
  return [...rows.values()].sort((a, b) => a.band - b.band);
}

export function estimateNow(db: Db, facts: Map<string, VtFact[]>): Estimate {
  return estimateVocabulary(bandInputs(db, facts), assumedKnown(db));
}

export const estimateView = (e: Estimate): VtEstimateView => ({ version: e.version, value: e.estimate, low: e.low, high: e.high, screened: e.screened, probes: e.probes, poolSize: e.poolSize, assumedKnown: e.assumedKnown });

/** seeded generator for plans (deterministic for a given seed) */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
