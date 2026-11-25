import { randomUUID } from "node:crypto";
import type { Db } from "../../../apps/server/src/db/open.js";
import { loadSettings } from "../../../apps/server/src/domain/sessions/policy.js";
import { prepareLexicon } from "../../../apps/server/src/domain/vocabTyping/lexicon.js";
import { setup, type Env } from "../wordLessons/fixtures.js";

export { setup, type Env };

/** a clock that moves forward by hand and ids that repeat from run to run */
export function makeDeps(start = "2026-11-24T10:00:00.000Z"): { now: () => Date; newId: () => string; advance: (ms: number) => void; set: (iso: string) => void } {
  let t = Date.parse(start);
  let n = 0;
  return {
    now: () => new Date(t),
    newId: () => `id-${String(++n).padStart(6, "0")}`,
    advance: (ms) => {
      t += ms;
    },
    set: (iso) => {
      t = Date.parse(iso);
    },
  };
}

/** fictional lemmas: "aaa", "aab", ... (letters only, like the word bank) */
export const lemmaAt = (i: number): string => {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  return `w${letters[Math.floor(i / 676) % 26]}${letters[Math.floor(i / 26) % 26]}${letters[i % 26]}`;
};

/** a word bank of n fictional words (rank = position + 1), the CSV that ranks them, and the prepared lexicon */
/** a new settings revision with the given values on top of the latest one */
export function useSettings(db: Db, patch: Record<string, unknown>): void {
  const cur = loadSettings(db);
  db.prepare("INSERT INTO settings_revisions(id, revision, values_json, created_at) VALUES (?,?,?,?)").run(`rev-${cur.revision + 1}`, cur.revision + 1, JSON.stringify({ ...cur.values, ...patch }), "2026-11-24T00:00:00Z");
}

export function seedPool(db: Db, n: number, now = new Date("2026-11-24T00:00:00Z"), skipTop = 0): { csv: string; lemmas: string[] } {
  const ins = db.prepare("INSERT INTO typing_word_bank(lemma, char_count, part_of_speech, translation_ru, definition_ru, transcription, difficulty, status, source_sha256, imported_at, typing_ok, past_forms, participle_forms) VALUES (?,?,?,?,?,?,?,'draft','sha',?,1,'[]','[]')");
  const lemmas: string[] = [];
  const lines = ["id;English word;Russian translation"];
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const lemma = lemmaAt(i);
      lemmas.push(lemma);
      ins.run(lemma, lemma.length, "noun", `слово${i}`, "", "tɛst", 2, now.toISOString());
      lines.push(`${i + 1};${lemma};слово${i}`);
    }
  })();
  const csv = lines.join("\n");
  prepareLexicon(db, csv, now);
  useSettings(db, { vtSkipTopRanks: skipTop });
  return { csv, lemmas };
}

export const uuid = (): string => randomUUID();
export const typing = { activeMs: 1200, chars: 5, errors: 1 };

const TEMPLATES = ["He looked at the X again.", "She talked about the X today.", "We often think of the X here.", "They saw the X near home.", "You can find the X there."];

/** n usable sentences for each lemma (written straight into the tables: the filters are tested with the importer) */
export function seedSentences(db: Db, lemmas: readonly string[], n: number): void {
  const stamp = "2026-11-20T00:00:00.000Z";
  if (!db.prepare("SELECT 1 FROM vocab_typing_imports WHERE id = 'imp-test'").get()) db.prepare("INSERT INTO vocab_typing_imports(id, corpus, version, inputs_json, counts_json, created_at) VALUES ('imp-test','tatoeba','test','{}','{}',?)").run(stamp);
  let enId = (db.prepare("SELECT COALESCE(MAX(source_en_id), 0) AS n FROM vocab_typing_sentences").get() as { n: number }).n;
  const sentence = db.prepare("INSERT INTO vocab_typing_sentences(id, source, source_en_id, source_ru_id, text_en, text_ru, author_en, author_ru, license_en, license_ru, word_count, difficulty_score, import_id, created_at) VALUES (?,'tatoeba',?,?,?,?,'a','b','CC BY 2.0 FR','CC BY 2.0 FR',6,100,'imp-test',?)");
  const target = db.prepare("INSERT INTO vocab_typing_sentence_targets(sentence_id, lemma, start, length, surface, ambiguous, rank_for_lemma) VALUES (?,?,?,?,?,0,?)");
  const status = db.prepare("INSERT INTO vocab_typing_sentence_status(id, sentence_id, lemma, status, actor, created_at) VALUES (?,?,NULL,'validated','code',?)");
  db.transaction(() => {
    for (const lemma of lemmas) {
      for (let i = 0; i < n; i++) {
        enId++;
        const text = TEMPLATES[i % TEMPLATES.length]!.replace("X", lemma);
        const id = `s-${lemma}-${i}`;
        sentence.run(id, enId, enId + 1_000_000, text, `Пример номер ${enId}.`, stamp);
        target.run(id, lemma, text.indexOf(lemma), lemma.length, lemma, i + 1);
        status.run(`st-${id}`, id, stamp);
      }
      db.prepare("UPDATE vocab_typing_lexicon SET context_count = ? WHERE lemma = ?").run(n, lemma);
    }
  })();
}
