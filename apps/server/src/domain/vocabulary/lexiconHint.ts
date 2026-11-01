import { readFile } from "node:fs/promises";

/**
 * One row of the user's old word list (a local `;`-separated CSV, D69), reduced to the few columns worth checking. The file is never imported
 * into the database and the app works without it: a row is only a HINT that the local model checks and corrects, because the list was written
 * by an older model and contains errors (wrong parts of speech, duplicated examples).
 */
export interface LexiconHint {
  partOfSpeech: string;
  transcription: string;
  definitionRu: string;
  synonyms: string[];
  irregularForms: string;
  translationsRu: string;
  /** occurrences figure from the list's second column (despite its header), or null */
  frequency: number | null;
}

const COLUMNS = {
  word: "English word",
  frequency: "Russian translation",
  irregular: "Irregular verb forms",
  translations: "Translations",
  definition: "Definition / Description",
  transcription: "Transcription",
  pos: "Part of speech (English)",
  synonyms: "Synonyms",
} as const;

/** one line of a `;`-separated file with "…" quoting; the file has no line breaks inside a field */
export function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ";") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const short = (s: string | undefined, max: number): string => (s ?? "").trim().slice(0, max);

export function parseLexicon(text: string): Map<string, LexiconHint> {
  const map = new Map<string, LexiconHint>();
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const header = splitLine(lines[0] ?? "");
  const at = (name: string): number => header.indexOf(name);
  const idx = Object.fromEntries(Object.entries(COLUMNS).map(([k, name]) => [k, at(name)])) as Record<keyof typeof COLUMNS, number>;
  if (idx.word < 0) return map;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "") continue;
    const row = splitLine(lines[i]!);
    const word = (row[idx.word] ?? "").trim().toLowerCase();
    if (word === "" || map.has(word)) continue;
    const freq = Number.parseFloat((row[idx.frequency] ?? "").replace(",", "."));
    map.set(word, {
      partOfSpeech: short(row[idx.pos], 30),
      transcription: short(row[idx.transcription], 60),
      definitionRu: short(row[idx.definition], 300),
      synonyms: short(row[idx.synonyms], 300).split(",").map((s) => s.trim()).filter(Boolean).slice(0, 8),
      irregularForms: short(row[idx.irregular], 60),
      translationsRu: short(row[idx.translations], 200),
      frequency: Number.isFinite(freq) && freq >= 0 ? freq : null,
    });
  }
  return map;
}

/** Lazy, once per process: the file is read on the first lookup and only the reduced rows are kept. A missing or unreadable file means no hints. */
export class LexiconHints {
  private loaded: Promise<Map<string, LexiconHint>> | null = null;
  constructor(private readonly file: string | undefined) {}

  async lookup(lemma: string): Promise<LexiconHint | null> {
    if (!this.file) return null;
    this.loaded ??= readFile(this.file, "utf8").then(parseLexicon, () => new Map<string, LexiconHint>());
    return (await this.loaded).get(lemma.trim().toLowerCase()) ?? null;
  }
}
