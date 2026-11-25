import type { Db } from "../../db/open.js";
import { splitLine } from "../vocabulary/lexiconHint.js";

export interface WordBankDeps {
  now: () => Date;
}

export interface WordBankImportResult {
  imported: number;
  skipped: { notLetters: number; badLength: number; noTranslation: number; duplicate: number };
  /** rows kept for lookup only (difficulty 1 or a capitalised word); Typing Words does not use them */
  lookupOnly: number;
  /** words that received irregular past / past participle forms */
  irregularVerbs: number;
  /** archived words whose archive flag the reseed kept (D184) */
  keptOut: number;
}

const COLUMN_NAMES = {
  word: "English word",
  difficulty: "Difficulty",
  translations: "Translations",
  definition: "Definition / Description",
  transcription: "Transcription",
  pos: "Part of speech (English)",
} as const;

function firstCyrillic(value: string): string {
  for (const part of value.split(",")) {
    const t = part.trim().replace(/\([^)]*\)/g, "").trim();
    if (/[\u0400-\u04FF]/.test(t)) return t;
  }
  return "";
}

/** Written in capitals in the CSV but an ordinary word (the boolean literal), so it stays usable in Typing Words. */
const ORDINARY_CAPS = new Set(["FALSE"]);

/**
 * Import of the learner's old CSV into the replaceable `typing_word_bank` (D72). Columns are found by header name.
 * The whole bank is replaced in one transaction (`DELETE` + inserts), so a reseed is idempotent and never touches history.
 * Every word is kept for the word panel's translation lookup: the lemma is lower-cased, and only words that are not plain
 * `a-z` letters (hyphens, accents, "a/b"), have the wrong length or no Cyrillic translation are dropped. Typing Words only uses
 * rows with `typing_ok = 1`: written in lowercase in the CSV (or in ORDINARY_CAPS) and Difficulty 2..5.
 */
/**
 * Parses the irregular verb list ({ "arise": [{ "2": ["arose"], "3": ["arisen"] }], ... }) into base -> past / participle forms.
 * Several senses of one verb are merged; only plain a-z forms different from the base are kept (the lookup finds the base word itself).
 */
export function parseIrregularVerbs(json: string): Map<string, { past: string[]; participle: string[] }> {
  const out = new Map<string, { past: string[]; participle: string[] }>();
  const data = JSON.parse(json) as Record<string, unknown>;
  const clean = (base: string, v: unknown): string[] =>
    Array.isArray(v) ? v.filter((f): f is string => typeof f === "string").map((f) => f.trim().toLowerCase()).filter((f) => /^[a-z]+$/.test(f) && f !== base) : [];
  for (const [rawBase, senses] of Object.entries(data)) {
    const base = rawBase.trim().toLowerCase();
    if (!Array.isArray(senses)) continue;
    const past = new Set<string>();
    const participle = new Set<string>();
    for (const sense of senses as Array<Record<string, unknown>>) {
      clean(base, sense["2"]).forEach((f) => past.add(f));
      clean(base, sense["3"]).forEach((f) => participle.add(f));
    }
    if (past.size > 0 || participle.size > 0) out.set(base, { past: [...past], participle: [...participle] });
  }
  return out;
}

export function importWordBank(db: Db, csvText: string, sourceSha: string, deps: WordBankDeps, irregularJson?: string): WordBankImportResult {
  const irregular = irregularJson ? parseIrregularVerbs(irregularJson) : new Map<string, { past: string[]; participle: string[] }>();
  let irregularVerbs = 0;
  const lines = csvText.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = splitLine(lines[0] ?? "");
  const at = (name: string): number => header.indexOf(name);
  const idx = {
    word: at(COLUMN_NAMES.word),
    difficulty: at(COLUMN_NAMES.difficulty),
    translations: at(COLUMN_NAMES.translations),
    definition: at(COLUMN_NAMES.definition),
    transcription: at(COLUMN_NAMES.transcription),
    pos: at(COLUMN_NAMES.pos),
  };
  if (idx.word < 0 || idx.difficulty < 0 || idx.translations < 0) {
    throw new Error("CSV is missing one of the required columns: 'English word', 'Difficulty', 'Translations'");
  }

  const skipped = { notLetters: 0, badLength: 0, noTranslation: 0, duplicate: 0 };
  const seen = new Set<string>();
  let lookupOnly = 0;
  const rows: Array<Record<string, string | number | null>> = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "") continue;
    const r = splitLine(lines[i]!);
    const raw = (r[idx.word] ?? "").trim();
    const word = raw.toLowerCase();
    if (!/^[a-z]+$/.test(word)) {
      skipped.notLetters++;
      continue;
    }
    if (word.length < 2 || word.length > 32) {
      skipped.badLength++;
      continue;
    }
    const difficulty = Number.parseInt((r[idx.difficulty] ?? "").trim(), 10);
    const translation = firstCyrillic(r[idx.translations] ?? "");
    if (!(difficulty >= 1 && difficulty <= 5) || !translation) {
      skipped.noTranslation++;
      continue;
    }
    if (seen.has(word)) {
      skipped.duplicate++;
      continue;
    }
    seen.add(word);
    const typingOk = difficulty >= 2 && (raw === word || ORDINARY_CAPS.has(raw)) ? 1 : 0;
    if (!typingOk) lookupOnly++;
    const forms = irregular.get(word);
    if (forms) irregularVerbs++;
    rows.push({
      lemma: word,
      char_count: word.length,
      part_of_speech: (r[idx.pos] ?? "").trim() || "other",
      translation_ru: translation,
      definition_ru: (r[idx.definition] ?? "").trim(),
      transcription: (r[idx.transcription] ?? "").trim(),
      difficulty,
      status: "draft",
      source_sha256: sourceSha,
      imported_at: deps.now().toISOString(),
      typing_ok: typingOk,
      frequency: Number.isFinite(Number((r[2] ?? "").trim().replace(",", "."))) && (r[2] ?? "").trim() !== "" ? Number((r[2] ?? "").trim().replace(",", ".")) : null,
      past_forms: JSON.stringify(forms?.past ?? []),
      participle_forms: JSON.stringify(forms?.participle ?? []),
    });
  }

  let keptOut = 0;
  let archivedBefore: Array<{ lemma: string; archBy: string | null; archAt: string | null; archReason: string | null }> = [];
  db.transaction(() => {
    // Vocabulary Typing refines translations and archives words in the bank (D175, D184): a reseed must neither undo a refinement nor bring an archived word back into practice
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vocab_typing_lexicon'").get()) {
      const refined = new Map((db.prepare("SELECT lemma, primary_translation_ru AS tr FROM vocab_typing_lexicon WHERE primary_translation_ru IS NOT NULL").all() as Array<{ lemma: string; tr: string }>).map((l) => [l.lemma, l.tr]));
      for (const row of rows) if (refined.has(row.lemma as string)) row.translation_ru = refined.get(row.lemma as string)!;
    }
    const hasArchive = (db.prepare("PRAGMA table_info(typing_word_bank)").all() as Array<{ name: string }>).some((c) => c.name === "archived");
    archivedBefore = hasArchive ? (db.prepare("SELECT lemma, archived_by AS archBy, archived_at AS archAt, archive_reason AS archReason FROM typing_word_bank WHERE archived = 1").all() as Array<{ lemma: string; archBy: string | null; archAt: string | null; archReason: string | null }>) : [];
    db.prepare("DELETE FROM typing_word_bank").run();
    const ins = db.prepare(
      "INSERT INTO typing_word_bank(lemma, char_count, part_of_speech, translation_ru, definition_ru, transcription, difficulty, status, source_sha256, imported_at, typing_ok, past_forms, participle_forms, frequency) VALUES (@lemma, @char_count, @part_of_speech, @translation_ru, @definition_ru, @transcription, @difficulty, @status, @source_sha256, @imported_at, @typing_ok, @past_forms, @participle_forms, @frequency)",
    );
    for (const row of rows) ins.run(row);
    if (archivedBefore.length > 0) {
      const put = db.prepare("UPDATE typing_word_bank SET archived = 1, archived_by = ?, archived_at = ?, archive_reason = ? WHERE lemma = ?");
      for (const x of archivedBefore) keptOut += put.run(x.archBy, x.archAt, x.archReason, x.lemma).changes;
    }
  }).immediate();

  return { imported: rows.length, skipped, lookupOnly, irregularVerbs, keptOut };
}
