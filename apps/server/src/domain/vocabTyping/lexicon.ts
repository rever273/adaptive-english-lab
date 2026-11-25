import type { Db } from "../../db/open.js";
import { splitLine } from "../vocabulary/lexiconHint.js";

/** a band is 1000 frequency ranks (D164) */
export const BAND_SIZE = 1000;
export const bandOf = (rank: number): number => Math.ceil(rank / BAND_SIZE);

export interface PrepareResult {
  csvWords: number;
  /** lemmas that received (or kept) a rank */
  ranked: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** word-bank lemmas the CSV has no usable row for (they stay out of the pool) */
  withoutRank: number;
  /** rows of the CSV whose id was not a positive integer or repeated an earlier id */
  badId: number;
  /** word-bank rows whose `frequency` was written or changed */
  frequencyUpdated: number;
}

export interface CsvRank {
  rank: number;
  frequency: number | null;
}

/**
 * The frequency of a CSV row is its THIRD column (the header of that column in the file is wrong, D178); the rank is the order by frequency, highest
 * first, ties by the `id` of the row. The first row of a spelling wins, like the word bank import. Ranks cover every word of the CSV, so deleting words
 * from the bank later never moves the others.
 */
export function readRanks(csvText: string): { ranks: Map<string, CsvRank>; csvWords: number; badId: number } {
  const lines = csvText.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = splitLine(lines[0] ?? "");
  const idCol = header.indexOf("id");
  const wordCol = header.indexOf("English word");
  if (idCol < 0 || wordCol < 0) throw new Error("CSV is missing the columns 'id' and 'English word'");
  const rows: Array<{ word: string; id: number; frequency: number | null }> = [];
  const seen = new Set<string>();
  const usedIds = new Set<number>();
  let badId = 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "") continue;
    const r = splitLine(lines[i]!);
    const word = (r[wordCol] ?? "").trim().toLowerCase();
    if (!/^[a-z]+$/.test(word) || seen.has(word)) continue;
    seen.add(word);
    const id = Number.parseInt((r[idCol] ?? "").trim(), 10);
    if (!(id >= 1) || usedIds.has(id)) {
      badId++;
      continue;
    }
    usedIds.add(id);
    const f = Number((r[2] ?? "").trim().replace(",", "."));
    rows.push({ word, id, frequency: Number.isFinite(f) && (r[2] ?? "").trim() !== "" ? f : null });
  }
  rows.sort((a, b) => (b.frequency ?? -1) - (a.frequency ?? -1) || a.id - b.id);
  const ranks = new Map<string, CsvRank>();
  rows.forEach((r, i) => ranks.set(r.word, { rank: i + 1, frequency: r.frequency }));
  return { ranks, csvWords: rows.length + badId, badId };
}

/**
 * `npm run vtyping:prepare` (D164, D178): gives every lemma its frequency rank and band and writes the CSV frequency into `typing_word_bank.frequency`.
 * Idempotent; cleanup decisions (eligibility, translations, context counts) are never touched. New lemmas start as `unreviewed`. Lemmas that were removed
 * from the bank keep their lexicon row (the marker "do not bring back") and are re-ranked with the rest so ranks stay unique.
 */
export function prepareLexicon(db: Db, csvText: string, now: Date): PrepareResult {
  const { ranks, csvWords, badId } = readRanks(csvText);
  const bank = new Set((db.prepare("SELECT lemma FROM typing_word_bank").all() as Array<{ lemma: string }>).map((r) => r.lemma));
  const stamp = now.toISOString();
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let withoutRank = 0;
  let frequencyUpdated = 0;
  db.transaction(() => {
    const existing = new Map((db.prepare("SELECT lemma, freq_rank AS rank FROM vocab_typing_lexicon").all() as Array<{ lemma: string; rank: number }>).map((r) => [r.lemma, r.rank]));
    const todo: Array<{ lemma: string; rank: number }> = [];
    for (const lemma of new Set([...bank, ...existing.keys()])) {
      const r = ranks.get(lemma);
      if (!r) {
        if (bank.has(lemma)) withoutRank++;
        continue;
      }
      if (existing.get(lemma) === r.rank) unchanged++;
      else todo.push({ lemma, rank: r.rank });
    }
    // the rank is UNIQUE: move the rows that change out of the way first, so a re-ranked CSV cannot collide with itself
    const park = db.prepare("UPDATE vocab_typing_lexicon SET freq_rank = freq_rank + 100000000 WHERE lemma = ?");
    for (const t of todo) if (existing.has(t.lemma)) park.run(t.lemma);
    const ins = db.prepare("INSERT INTO vocab_typing_lexicon(lemma, freq_rank, band, eligibility, updated_at) VALUES (?,?,?,'unreviewed',?)");
    const upd = db.prepare("UPDATE vocab_typing_lexicon SET freq_rank = ?, band = ?, updated_at = ? WHERE lemma = ?");
    for (const t of todo) {
      if (existing.has(t.lemma)) {
        upd.run(t.rank, bandOf(t.rank), stamp, t.lemma);
        updated++;
      } else {
        ins.run(t.lemma, t.rank, bandOf(t.rank), stamp);
        inserted++;
      }
    }
    const setFreq = db.prepare("UPDATE typing_word_bank SET frequency = ? WHERE lemma = ? AND frequency IS NOT ?");
    for (const lemma of bank) {
      const r = ranks.get(lemma);
      if (r) frequencyUpdated += setFreq.run(r.frequency, lemma, r.frequency).changes;
    }
  }).immediate();
  return { csvWords, ranked: inserted + updated + unchanged, inserted, updated, unchanged, withoutRank, badId, frequencyUpdated };
}
