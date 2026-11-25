import type { Db } from "../../db/open.js";
import { normalizeWord, regularForms } from "./forms.js";

/** `form` says how the looked-up word relates to the base word; absent for an exact match or a regular ending (-s, -ed, -ing). */
export interface WordBankMatch { lemma: string; translationRu: string; partOfSpeech: string; form?: "past" | "participle" }

const SELECT = "SELECT lemma, translation_ru AS translationRu, part_of_speech AS partOfSpeech FROM typing_word_bank";

/**
 * Irregular forms -> their bases, built once per database: finding them by SQL scans all ~20k rows (~5 ms a column), and a word
 * missing from the bank needs both columns. The index is rebuilt when the bank's row count or latest import changes; that check is
 * itself a scan (~4 ms), so it runs at most once per INDEX_CHECK_MS (the bank changes only by a seed or import).
 */
const INDEX_CHECK_MS = 30_000;
const irregularIndex = new WeakMap<Db, { key: string; checkedAt: number; byForm: Map<string, WordBankMatch[]> }>();
function irregularForms(db: Db): Map<string, WordBankMatch[]> {
  const cached = irregularIndex.get(db);
  if (cached && Date.now() - cached.checkedAt < INDEX_CHECK_MS) return cached.byForm;
  const sig = db.prepare("SELECT COUNT(*) AS n, MAX(imported_at) AS at FROM typing_word_bank").get() as { n: number; at: string | null };
  const key = `${sig.n}|${sig.at ?? ""}`;
  if (cached?.key === key) {
    cached.checkedAt = Date.now();
    return cached.byForm;
  }
  const byForm = new Map<string, WordBankMatch[]>();
  const rows = db.prepare("SELECT lemma, translation_ru AS translationRu, part_of_speech AS partOfSpeech, past_forms AS past, participle_forms AS participle FROM typing_word_bank WHERE past_forms <> '[]' OR participle_forms <> '[]'").all() as Array<WordBankMatch & { past: string; participle: string }>;
  // past before participle, as the order of the lookup has always been
  for (const form of ["past", "participle"] as const) {
    for (const r of rows) {
      for (const f of JSON.parse(r[form]) as string[]) {
        const list = byForm.get(f) ?? [];
        if (!list.some((m) => m.lemma === r.lemma)) list.push({ lemma: r.lemma, translationRu: r.translationRu, partOfSpeech: r.partOfSpeech, form });
        byForm.set(f, list);
      }
    }
  }
  irregularIndex.set(db, { key, checkedAt: Date.now(), byForm });
  return byForm;
}

/** Bases whose irregular past (2nd) or past participle (3rd) form is exactly `word`: arisen -> arise. */
function irregularBases(db: Db, word: string): WordBankMatch[] {
  return irregularForms(db).get(word) ?? [];
}

/** Bases that the regular endings turn into `word`. Each guessed stem is verified against the forward rules, so a guess alone never matches. */
function regularBases(db: Db, word: string): WordBankMatch[] {
  const find = db.prepare(`${SELECT} WHERE lemma = ?`);
  const candidates = new Set<string>();
  const stem = (s: string) => {
    candidates.add(s);
    candidates.add(`${s}e`);
    if (/(.)\1$/.test(s)) candidates.add(s.slice(0, -1));
  };
  if (word.endsWith("s")) stem(word.slice(0, -1));
  if (word.endsWith("es")) stem(word.slice(0, -2));
  if (word.endsWith("ies")) candidates.add(`${word.slice(0, -3)}y`);
  if (word.endsWith("ied")) candidates.add(`${word.slice(0, -3)}y`);
  if (word.endsWith("ed")) stem(word.slice(0, -2));
  if (word.endsWith("d")) stem(word.slice(0, -1));
  if (word.endsWith("ing")) stem(word.slice(0, -3));
  return [...candidates].filter((s) => s.length >= 2 && regularForms(s).includes(word))
    .map((s) => find.get(s) as WordBankMatch | undefined)
    .filter((row): row is WordBankMatch => row !== undefined);
}

/**
 * The one place that turns a word as written into its translation from the reference bank (used by the word panel and by Typing Words).
 * Order: the word itself, then the base verb of an irregular past / past participle (arisen -> arise), then a regular ending
 * (studies -> study). The first step that finds anything wins, so an exact entry is never overridden by a guessed base.
 */
export function lookupWordBank(db: Db, text: string): WordBankMatch[] {
  const word = normalizeWord(text);
  if (!/^[a-z]{2,32}$/.test(word)) return [];
  const exact = db.prepare(`${SELECT} WHERE lemma = ?`).get(word) as WordBankMatch | undefined;
  if (exact) return [exact];
  const irregular = irregularBases(db, word);
  if (irregular.length > 0) return irregular;
  return regularBases(db, word);
}

/** The best single match (first), or null: for places that show one translation. */
export function lookupBankTranslation(db: Db, text: string): WordBankMatch | null {
  return lookupWordBank(db, text)[0] ?? null;
}
