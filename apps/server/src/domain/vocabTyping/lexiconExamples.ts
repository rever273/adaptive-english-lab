import { createHash } from "node:crypto";
import type { Db } from "../../db/open.js";
import { splitLine } from "../vocabulary/lexiconHint.js";
import { buildFormIndex, matchSentence, tokenize, type PoolWord } from "./matching.js";
import { acceptEnglish, acceptRussian, byQuality, coverage, normalKey, SENTENCES_PER_LEMMA, UNKNOWN_RANK, type Candidate, type ImportDeps, type ImportReport } from "./tatoeba.js";

/**
 * The learner's own dictionary (the CSV) as a second source of example sentences (D179): every "Example sentence N" / "Example translation N" pair (up to
 * 26 per word) goes through the SAME code checks as the Tatoeba corpus (the word found as a whole token by its forms, 3-16 words, typable ASCII, a Cyrillic
 * translation, blacklist, no duplicate within the word or with what is stored) and is stored with source 'lexicon'. A word keeps at most
 * SENTENCES_PER_LEMMA sentences in all; Tatoeba sentences already stored rank first.
 */
export const LEXICON_FILTER_VERSION = "vt-lexicon-v1";
export const LEXICON_LICENSE = "own dictionary";

export function readExamples(csvText: string): Map<string, Array<{ en: string; ru: string; n: number }>> {
  const lines = csvText.replace(/^﻿/, "").split(/\r?\n/);
  const header = splitLine(lines[0] ?? "");
  const wordCol = header.indexOf("English word");
  if (wordCol < 0) throw new Error("CSV is missing the column 'English word'");
  const pairs: Array<[number, number, number]> = [];
  for (let n = 1; n <= 99; n++) {
    const en = header.indexOf(`Example sentence ${n}`);
    const ru = header.indexOf(`Example translation ${n}`);
    if (en >= 0 && ru >= 0) pairs.push([en, ru, n]);
  }
  const out = new Map<string, Array<{ en: string; ru: string; n: number }>>();
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "") continue;
    const r = splitLine(lines[i]!);
    const word = (r[wordCol] ?? "").trim().toLowerCase();
    if (!/^[a-z]+$/.test(word) || out.has(word)) continue;
    out.set(word, pairs.map(([e, t, n]) => ({ en: (r[e] ?? "").trim(), ru: (r[t] ?? "").trim(), n })).filter((p) => p.en && p.ru));
  }
  return out;
}

export type LexiconImportReport = ImportReport & { examplesInCsv: number; rejected: Record<string, number> };

export function importLexiconExamples(db: Db, csvText: string, blacklist: ReadonlySet<string>, deps: ImportDeps, log: (m: string) => void = () => {}): LexiconImportReport {
  const sha = createHash("sha256").update(csvText).digest("hex");
  const version = createHash("sha256").update(`${sha}:${LEXICON_FILTER_VERSION}`).digest("hex").slice(0, 16);
  const existing = db.prepare("SELECT id FROM vocab_typing_imports WHERE corpus = 'lexicon' AND version = ?").get(version) as { id: string } | undefined;
  if (existing) {
    const c = coverage(db);
    return { skipped: true, importId: existing.id, version, linkedPairs: 0, englishAccepted: 0, pairsWithTranslation: 0, sentencesStored: 0, targetsStored: 0, examplesInCsv: 0, rejected: {}, lemmas: c.coverage.reduce((s, b) => s + b.lemmas, 0), ...c };
  }
  const rows = db.prepare("SELECT b.lemma, b.part_of_speech AS pos, b.past_forms AS past, b.participle_forms AS participle, l.freq_rank AS rank FROM typing_word_bank b JOIN vocab_typing_lexicon l ON l.lemma = b.lemma WHERE l.eligibility <> 'excluded' AND b.archived = 0").all() as Array<{ lemma: string; pos: string; past: string; participle: string; rank: number }>;
  const pool: PoolWord[] = rows.map((r) => ({ lemma: r.lemma, pos: r.pos, past: JSON.parse(r.past) as string[], participle: JSON.parse(r.participle) as string[] }));
  const rankOf = new Map(rows.map((r) => [r.lemma, r.rank]));
  const index = buildFormIndex(pool);
  const tokenRank = (lower: string): number => {
    const ls = index.get(lower);
    return ls ? Math.min(...ls.map((l) => rankOf.get(l) ?? UNKNOWN_RANK)) : UNKNOWN_RANK;
  };
  const stored = new Map<string, Set<string>>();
  for (const r of db.prepare("SELECT t.lemma, s.text_en AS text FROM vocab_typing_sentence_targets t JOIN vocab_typing_sentences s ON s.id = t.sentence_id").all() as Array<{ lemma: string; text: string }>) {
    const set = stored.get(r.lemma) ?? new Set<string>();
    set.add(normalKey(r.text));
    stored.set(r.lemma, set);
  }
  const counts = new Map((db.prepare("SELECT lemma, COUNT(*) AS n FROM vocab_typing_sentence_targets GROUP BY lemma").all() as Array<{ lemma: string; n: number }>).map((r) => [r.lemma, r.n]));

  const examples = readExamples(csvText);
  const rejected: Record<string, number> = {};
  const bump = (k: string): void => void (rejected[k] = (rejected[k] ?? 0) + 1);
  let examplesInCsv = 0;
  let accepted = 0;
  const chosen = new Map<string, Candidate[]>();
  for (const r of rows) {
    const list = examples.get(r.lemma) ?? [];
    examplesInCsv += list.length;
    const seen = new Set(stored.get(r.lemma) ?? []);
    const cands: Candidate[] = [];
    for (const ex of list) {
      const text = acceptEnglish(ex.en, blacklist);
      if (!text) {
        bump("english_filter");
        continue;
      }
      if (!acceptRussian(ex.ru)) {
        bump("russian_filter");
        continue;
      }
      const key = normalKey(text);
      if (seen.has(key)) {
        bump("duplicate");
        continue;
      }
      const m = matchSentence(text, index).find((x) => x.lemma === r.lemma);
      if (!m) {
        bump("word_not_found");
        continue;
      }
      seen.add(key);
      const tokens = tokenize(text);
      let difficulty = 0;
      tokens.forEach((t, i) => {
        if (t.start === m.start) return;
        if (i > 0 && /^[A-Z]/.test(t.text) && t.text !== "I") return;
        difficulty = Math.max(difficulty, tokenRank(t.lower));
      });
      cands.push({ enId: r.rank * 100 + ex.n, ruId: r.rank * 100 + ex.n, text, textRu: ex.ru, authorEn: null, authorRu: null, words: tokens.length, difficulty, ambiguous: m.ambiguous, start: m.start, length: m.length, surface: m.surface });
      accepted++;
    }
    const room = SENTENCES_PER_LEMMA - (counts.get(r.lemma) ?? 0);
    if (room > 0 && cands.length > 0) chosen.set(r.lemma, cands.sort(byQuality).slice(0, room));
  }
  log(`examples in the CSV: ${examplesInCsv}; passed the checks: ${accepted}; rejected ${JSON.stringify(rejected)}`);

  const importId = deps.newId();
  const stamp = deps.now().toISOString();
  let sentencesStored = 0;
  let targetsStored = 0;
  db.transaction(() => {
    db.prepare("INSERT INTO vocab_typing_imports(id, corpus, version, inputs_json, counts_json, created_at) VALUES (?,?,?,?,?,?)").run(importId, "lexicon", version, JSON.stringify({ csvSha256: sha, filterVersion: LEXICON_FILTER_VERSION }), JSON.stringify({ examplesInCsv, accepted, rejected }), stamp);
    const put = db.prepare("INSERT OR IGNORE INTO vocab_typing_sentences(id, source, source_en_id, source_ru_id, text_en, text_ru, author_en, author_ru, license_en, license_ru, word_count, difficulty_score, import_id, created_at) VALUES (?,'lexicon',?,?,?,?,NULL,NULL,?,?,?,?,?,?)");
    const status = db.prepare("INSERT INTO vocab_typing_sentence_status(id, sentence_id, lemma, status, actor, reason, created_at) VALUES (?,?,NULL,'validated','code',?,?)");
    const target = db.prepare("INSERT OR IGNORE INTO vocab_typing_sentence_targets(sentence_id, lemma, start, length, surface, ambiguous, rank_for_lemma) VALUES (?,?,?,?,?,?,?)");
    const maxRank = db.prepare("SELECT COALESCE(MAX(rank_for_lemma), 0) AS n FROM vocab_typing_sentence_targets WHERE lemma = ?");
    for (const [lemma, list] of [...chosen].sort((a, b) => a[0].localeCompare(b[0]))) {
      let rank = (maxRank.get(lemma) as { n: number }).n;
      for (const c of list) {
        const id = `vts-lex-${c.enId}`;
        if (put.run(id, c.enId, c.ruId, c.text, c.textRu, LEXICON_LICENSE, LEXICON_LICENSE, c.words, c.difficulty, importId, stamp).changes > 0) {
          sentencesStored++;
          status.run(deps.newId(), id, `import ${version}`, stamp);
        }
        targetsStored += target.run(id, lemma, c.start, c.length, c.surface, c.ambiguous ? 1 : 0, ++rank).changes;
      }
    }
    db.prepare("UPDATE vocab_typing_lexicon SET context_count = (SELECT COUNT(*) FROM vocab_typing_sentence_targets t WHERE t.lemma = vocab_typing_lexicon.lemma), updated_at = ?").run(stamp);
  }).immediate();
  const c = coverage(db);
  return { skipped: false, importId, version, linkedPairs: 0, englishAccepted: accepted, pairsWithTranslation: accepted, sentencesStored, targetsStored, examplesInCsv, rejected, lemmas: c.coverage.reduce((s, b) => s + b.lemmas, 0), ...c };
}
