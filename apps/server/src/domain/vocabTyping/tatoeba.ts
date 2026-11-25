import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { VT_SENTENCE_WORDS } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { buildFormIndex, matchSentence, tokenize, type PoolWord } from "./matching.js";

/**
 * Import of the Tatoeba English-Russian corpus (D166). Only the best sentences per pool word are stored (never the whole corpus), each with its
 * Tatoeba ids, authors and licence. Filters are plain code; the corpus is untrusted text and is only ever read.
 */
export const FILTER_VERSION = "vt-tatoeba-v1";
export const SENTENCES_PER_LEMMA = 20;
/** a token the pool does not know counts as this rank in `difficulty_score` */
export const UNKNOWN_RANK = 30000;
const KEEP_PER_LEMMA = 40;

/** a typable English sentence for the mode, normalised (straight quotes, single spaces), or null */
export function acceptEnglish(raw: string, blacklist: ReadonlySet<string>): string | null {
  const text = raw.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
  if (text.length === 0 || text.length > 110) return null;
  if (!/^[\x20-\x7E]+$/.test(text)) return null;
  if (!/[.?!]["']?$/.test(text)) return null;
  if (/\d/.test(text) || /https?:|www\.|@|\.com\b|\.org\b|\.net\b/i.test(text)) return null;
  if (/\b[A-Z]{3,}\b/.test(text.replace(/\bI['A-Za-z]*/g, ""))) return null;
  if (/[<>{}\[\]\\|_*#~^=+]/.test(text)) return null;
  const words = tokenize(text);
  if (words.length < VT_SENTENCE_WORDS.min || words.length > VT_SENTENCE_WORDS.max) return null;
  if (words.some((t) => blacklist.has(t.lower))) return null;
  return text;
}

export function acceptRussian(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 200 && /[Ѐ-ӿ]/.test(t) && !/[A-Za-z]/.test(t) && !/https?:|www\./i.test(t);
}

/** the dedup key of an English sentence */
export const normalKey = (text: string): string => text.toLowerCase().replace(/[^a-z]+/g, " ").trim();

export interface Candidate {
  enId: number;
  ruId: number;
  text: string;
  textRu: string;
  authorEn: string | null;
  authorRu: string | null;
  words: number;
  difficulty: number;
  ambiguous: boolean;
  start: number;
  length: number;
  surface: string;
}

/** best first: unambiguous, easy words around it, a middling length (the same sentences win on every run) */
export const byQuality = (a: Candidate, b: Candidate): number =>
  Number(a.ambiguous) - Number(b.ambiguous) || a.difficulty - b.difficulty || Math.abs(a.words - 9) - Math.abs(b.words - 9) || a.enId - b.enId;

/** up to `limit` sentences: the best ones, with no more than three per spelling of the word while others are left (variety of forms) */
export function selectBest(cands: readonly Candidate[], limit = SENTENCES_PER_LEMMA): Candidate[] {
  const sorted = [...cands].sort(byQuality);
  const perForm = new Map<string, number>();
  const chosen: Candidate[] = [];
  for (const c of sorted) {
    const k = c.surface.toLowerCase();
    if (chosen.length >= limit) break;
    if ((perForm.get(k) ?? 0) >= 3) continue;
    perForm.set(k, (perForm.get(k) ?? 0) + 1);
    chosen.push(c);
  }
  for (const c of sorted) {
    if (chosen.length >= limit) break;
    if (!chosen.includes(c)) chosen.push(c);
  }
  return chosen.sort(byQuality);
}

async function eachRow(file: string, fn: (cols: string[]) => void): Promise<void> {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) if (line) fn(line.split("\t"));
}

export interface TatoebaFiles {
  engSentences: string;
  rusSentences: string;
  links: string;
  engCc0?: string;
  rusCc0?: string;
}
export interface TatoebaInputs {
  /** descriptors of the downloaded files (name, bytes, sha256, Last-Modified), recorded with the import */
  files: Array<{ name: string; bytes: number; sha256: string; exportDate?: string | null }>;
}

export interface CoverageBand {
  band: number;
  lemmas: number;
  atLeast3: number;
  oneOrTwo: number;
  none: number;
}
export interface ImportReport {
  skipped: boolean;
  importId: string;
  version: string;
  linkedPairs: number;
  englishAccepted: number;
  pairsWithTranslation: number;
  sentencesStored: number;
  targetsStored: number;
  lemmas: number;
  coverage: CoverageBand[];
  totals: { atLeast3: number; oneOrTwo: number; none: number };
}

export interface ImportDeps {
  now: () => Date;
  newId: () => string;
}

const COVERAGE_SQL = "SELECT l.band, COUNT(*) AS lemmas, SUM(l.context_count >= 3) AS a3, SUM(l.context_count BETWEEN 1 AND 2) AS a12, SUM(l.context_count = 0) AS a0 FROM typing_word_bank b JOIN vocab_typing_lexicon l ON l.lemma = b.lemma WHERE l.eligibility <> 'excluded' GROUP BY l.band ORDER BY l.band";

export function coverage(db: Db): { coverage: CoverageBand[]; totals: ImportReport["totals"] } {
  const rows = db.prepare(COVERAGE_SQL).all() as Array<{ band: number; lemmas: number; a3: number; a12: number; a0: number }>;
  const bands = rows.map((r) => ({ band: r.band, lemmas: r.lemmas, atLeast3: r.a3, oneOrTwo: r.a12, none: r.a0 }));
  return { coverage: bands, totals: { atLeast3: bands.reduce((s, b) => s + b.atLeast3, 0), oneOrTwo: bands.reduce((s, b) => s + b.oneOrTwo, 0), none: bands.reduce((s, b) => s + b.none, 0) } };
}

export async function importTatoeba(db: Db, files: TatoebaFiles, inputs: TatoebaInputs, blacklist: ReadonlySet<string>, deps: ImportDeps, log: (m: string) => void = () => {}): Promise<ImportReport> {
  const version = createHash("sha256").update(JSON.stringify({ files: inputs.files.map((f) => [f.name, f.sha256]), FILTER_VERSION })).digest("hex").slice(0, 16);
  const existing = db.prepare("SELECT id FROM vocab_typing_imports WHERE corpus = 'tatoeba' AND version = ?").get(version) as { id: string } | undefined;
  if (existing) {
    const c = coverage(db);
    return { skipped: true, importId: existing.id, version, linkedPairs: 0, englishAccepted: 0, pairsWithTranslation: 0, sentencesStored: 0, targetsStored: 0, lemmas: c.coverage.reduce((s, b) => s + b.lemmas, 0), ...c };
  }

  // the pool: word bank words that are not excluded, with their rank
  const rows = db.prepare("SELECT b.lemma, b.part_of_speech AS pos, b.past_forms AS past, b.participle_forms AS participle, l.freq_rank AS rank FROM typing_word_bank b JOIN vocab_typing_lexicon l ON l.lemma = b.lemma WHERE l.eligibility <> 'excluded'").all() as Array<{ lemma: string; pos: string; past: string; participle: string; rank: number }>;
  const pool: PoolWord[] = rows.map((r) => ({ lemma: r.lemma, pos: r.pos, past: JSON.parse(r.past) as string[], participle: JSON.parse(r.participle) as string[] }));
  const rankOfLemma = new Map(rows.map((r) => [r.lemma, r.rank]));
  const index = buildFormIndex(pool);
  const tokenRank = (lower: string): number => {
    const lemmas = index.get(lower);
    if (!lemmas) return UNKNOWN_RANK;
    return Math.min(...lemmas.map((l) => rankOfLemma.get(l) ?? UNKNOWN_RANK));
  };

  // links: English id -> Russian ids
  const links = new Map<number, number[]>();
  const wantedRu = new Set<number>();
  let linkedPairs = 0;
  await eachRow(files.links, (c) => {
    const en = Number(c[0]);
    const ru = Number(c[1]);
    if (!Number.isInteger(en) || !Number.isInteger(ru)) return;
    (links.get(en) ?? links.set(en, []).get(en)!).push(ru);
    wantedRu.add(ru);
    linkedPairs++;
  });
  log(`links: ${linkedPairs} pairs`);

  const russian = new Map<number, { text: string; author: string | null }>();
  await eachRow(files.rusSentences, (c) => {
    const id = Number(c[0]);
    if (!wantedRu.has(id) || !acceptRussian(c[2] ?? "")) return;
    russian.set(id, { text: c[2]!.trim(), author: c[3] && c[3] !== "\\N" ? c[3] : null });
  });
  log(`russian sentences kept: ${russian.size}`);

  const buffers = new Map<string, Candidate[]>();
  const seen = new Set<string>();
  let englishAccepted = 0;
  let pairsWithTranslation = 0;
  await eachRow(files.engSentences, (c) => {
    const enId = Number(c[0]);
    const ruIds = links.get(enId);
    if (!ruIds) return;
    const text = acceptEnglish(c[2] ?? "", blacklist);
    if (!text) return;
    englishAccepted++;
    const key = normalKey(text);
    if (seen.has(key)) return;
    let best: { id: number; text: string; author: string | null } | null = null;
    for (const id of ruIds) {
      const r = russian.get(id);
      if (r && (!best || r.text.length < best.text.length)) best = { id, ...r };
    }
    if (!best) return;
    const matches = matchSentence(text, index);
    if (matches.length === 0) return;
    seen.add(key);
    pairsWithTranslation++;
    const tokens = tokenize(text);
    for (const m of matches) {
      let difficulty = 0;
      tokens.forEach((t, i) => {
        if (t.start === m.start) return;
        if (i > 0 && /^[A-Z]/.test(t.text) && t.text !== "I") return;
        difficulty = Math.max(difficulty, tokenRank(t.lower));
      });
      const cand: Candidate = { enId, ruId: best.id, text, textRu: best.text, authorEn: c[3] && c[3] !== "\\N" ? c[3] : null, authorRu: best.author, words: tokens.length, difficulty, ambiguous: m.ambiguous, start: m.start, length: m.length, surface: m.surface };
      const list = buffers.get(m.lemma) ?? [];
      list.push(cand);
      if (list.length > KEEP_PER_LEMMA * 2) list.sort(byQuality).length = KEEP_PER_LEMMA;
      buffers.set(m.lemma, list);
    }
  });
  log(`english accepted: ${englishAccepted}; with a translation and a pool word: ${pairsWithTranslation}`);

  const cc0 = { en: new Set<number>(), ru: new Set<number>() };
  if (files.engCc0) await eachRow(files.engCc0, (c) => void cc0.en.add(Number(c[0])));
  if (files.rusCc0) await eachRow(files.rusCc0, (c) => void cc0.ru.add(Number(c[0])));

  const chosen = new Map<string, Candidate[]>();
  for (const [lemma, list] of buffers) chosen.set(lemma, selectBest(list));

  const importId = deps.newId();
  const stamp = deps.now().toISOString();
  let sentencesStored = 0;
  let targetsStored = 0;
  db.transaction(() => {
    db.prepare("INSERT INTO vocab_typing_imports(id, corpus, version, inputs_json, counts_json, created_at) VALUES (?,?,?,?,?,?)").run(importId, "tatoeba", version, JSON.stringify({ files: inputs.files, filterVersion: FILTER_VERSION }), JSON.stringify({ linkedPairs, englishAccepted, pairsWithTranslation }), stamp);
    const putSentence = db.prepare("INSERT OR IGNORE INTO vocab_typing_sentences(id, source, source_en_id, source_ru_id, text_en, text_ru, author_en, author_ru, license_en, license_ru, word_count, difficulty_score, import_id, created_at) VALUES (?,'tatoeba',?,?,?,?,?,?,?,?,?,?,?,?)");
    const idOf = db.prepare("SELECT id FROM vocab_typing_sentences WHERE source = 'tatoeba' AND source_en_id = ?");
    const putStatus = db.prepare("INSERT INTO vocab_typing_sentence_status(id, sentence_id, lemma, status, actor, reason, created_at) VALUES (?,?,NULL,'validated','code',?,?)");
    const putTarget = db.prepare("INSERT OR IGNORE INTO vocab_typing_sentence_targets(sentence_id, lemma, start, length, surface, ambiguous, rank_for_lemma) VALUES (?,?,?,?,?,?,?)");
    const maxRank = db.prepare("SELECT COALESCE(MAX(rank_for_lemma), 0) AS n FROM vocab_typing_sentence_targets WHERE lemma = ?");
    const stored = new Map<number, string>();
    for (const [lemma, list] of [...chosen].sort((a, b) => a[0].localeCompare(b[0]))) {
      let rank = (maxRank.get(lemma) as { n: number }).n;
      for (const c of list) {
        let sid = stored.get(c.enId);
        if (!sid) {
          const sentenceId = `vts-${c.enId}`;
          const r = putSentence.run(sentenceId, c.enId, c.ruId, c.text, c.textRu, c.authorEn, c.authorRu, cc0.en.has(c.enId) ? "CC0 1.0" : "CC BY 2.0 FR", cc0.ru.has(c.ruId) ? "CC0 1.0" : "CC BY 2.0 FR", c.words, c.difficulty, importId, stamp);
          sid = (idOf.get(c.enId) as { id: string }).id;
          if (r.changes > 0) {
            sentencesStored++;
            putStatus.run(deps.newId(), sid, `import ${version}`, stamp);
          }
          stored.set(c.enId, sid);
        }
        const t = putTarget.run(sid, lemma, c.start, c.length, c.surface, c.ambiguous ? 1 : 0, ++rank);
        targetsStored += t.changes;
      }
    }
    db.prepare("UPDATE vocab_typing_lexicon SET context_count = (SELECT COUNT(*) FROM vocab_typing_sentence_targets t WHERE t.lemma = vocab_typing_lexicon.lemma), updated_at = ?").run(stamp);
  }).immediate();
  const c = coverage(db);
  return { skipped: false, importId, version, linkedPairs, englishAccepted, pairsWithTranslation, sentencesStored, targetsStored, lemmas: c.coverage.reduce((s, b) => s + b.lemmas, 0), ...c };
}
