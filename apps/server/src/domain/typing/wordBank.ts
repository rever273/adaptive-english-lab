import type { Db } from "../../db/open.js";
import { splitLine } from "../vocabulary/lexiconHint.js";

export interface WordBankDeps {
  now: () => Date;
}

export interface WordBankImportResult {
  imported: number;
  skipped: { difficulty1: number; notLowercase: number; badLength: number; noTranslation: number };
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

/**
 * One-shot import of the learner's old CSV into the replaceable `typing_word_bank` (D72). Columns are found by header name.
 * The whole bank is replaced in one transaction (`DELETE` + inserts), so a reseed is idempotent and never touches history.
 * Only words that are exactly `^[a-z]+$` (no case folding, so `China`/`FALSE` are dropped), length 2..32, Difficulty 2..5 and a
 * Cyrillic translation are kept.
 */
export function importWordBank(db: Db, csvText: string, sourceSha: string, deps: WordBankDeps): WordBankImportResult {
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

  const skipped = { difficulty1: 0, notLowercase: 0, badLength: 0, noTranslation: 0 };
  const rows: Array<Record<string, string | number>> = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "") continue;
    const r = splitLine(lines[i]!);
    const word = (r[idx.word] ?? "").trim();
    if (!/^[a-z]+$/.test(word)) {
      skipped.notLowercase++;
      continue;
    }
    if (word.length < 2 || word.length > 32) {
      skipped.badLength++;
      continue;
    }
    const difficulty = Number.parseInt((r[idx.difficulty] ?? "").trim(), 10);
    if (!(difficulty >= 2 && difficulty <= 5)) {
      skipped.difficulty1++;
      continue;
    }
    const translation = firstCyrillic(r[idx.translations] ?? "");
    if (!translation) {
      skipped.noTranslation++;
      continue;
    }
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
    });
  }

  db.transaction(() => {
    db.prepare("DELETE FROM typing_word_bank").run();
    const ins = db.prepare(
      "INSERT INTO typing_word_bank(lemma, char_count, part_of_speech, translation_ru, definition_ru, transcription, difficulty, status, source_sha256, imported_at) VALUES (@lemma, @char_count, @part_of_speech, @translation_ru, @definition_ru, @transcription, @difficulty, @status, @source_sha256, @imported_at)",
    );
    for (const row of rows) ins.run(row);
  }).immediate();

  return { imported: rows.length, skipped };
}
