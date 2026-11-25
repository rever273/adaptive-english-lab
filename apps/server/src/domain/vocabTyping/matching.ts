import { matchForms } from "../vocabulary/forms.js";

/**
 * Lemma -> sentence matching without an NLP library (D167). The set of spellings of a lemma is generated (regular endings from `matchForms`, the word
 * bank's irregular past/participle forms, -er/-est of adjectives, a few irregular plurals and verbs) and a sentence is searched for WHOLE tokens only, so
 * `ongoing` is never `go` and `runner` is never `run`. The exact span of the surface form is kept. Version 1 has no part-of-speech tagging and no sense
 * separation: a form that belongs to two pool lemmas (`saw`: see, saw) makes both matches `ambiguous`.
 */
export const MATCH_VERSION = "vt-match-v1";

export interface PoolWord {
  lemma: string;
  pos: string;
  past: readonly string[];
  participle: readonly string[];
}

const IRREGULAR_PLURALS: Record<string, string[]> = {
  man: ["men"], woman: ["women"], child: ["children"], foot: ["feet"], tooth: ["teeth"], mouse: ["mice"], person: ["people"], goose: ["geese"],
  wife: ["wives"], life: ["lives"], knife: ["knives"], leaf: ["leaves"], wolf: ["wolves"], half: ["halves"], shelf: ["shelves"], thief: ["thieves"],
  loaf: ["loaves"], ox: ["oxen"], self: ["selves"], calf: ["calves"],
};
const IRREGULAR_COMPARATIVES: Record<string, string[]> = {
  good: ["better", "best"], bad: ["worse", "worst"], far: ["farther", "farthest", "further", "furthest"], little: ["less", "least"], many: ["more", "most"], much: ["more", "most"], old: ["elder", "eldest"],
};
const EXTRA_VERB_FORMS: Record<string, string[]> = { be: ["am", "is", "are", "being"], have: ["has"] };

/** own keys only: a lemma such as `constructor` must not find an Object.prototype member */
const own = (table: Record<string, string[]>, key: string): string[] => (Object.hasOwn(table, key) ? table[key]! : []);

function comparatives(lemma: string): string[] {
  if (Object.hasOwn(IRREGULAR_COMPARATIVES, lemma)) return IRREGULAR_COMPARATIVES[lemma]!;
  if (!/^[a-z]{2,10}$/.test(lemma)) return [];
  if (/[^aeiou]y$/.test(lemma)) return [`${lemma.slice(0, -1)}ier`, `${lemma.slice(0, -1)}iest`];
  if (lemma.endsWith("e")) return [`${lemma}r`, `${lemma}st`];
  const out = [`${lemma}er`, `${lemma}est`];
  if (/[^aeiou][aeiou][^aeiouwxy]$/.test(lemma) && lemma.length <= 5) out.push(`${lemma}${lemma.slice(-1)}er`, `${lemma}${lemma.slice(-1)}est`);
  return out;
}

/** every spelling that counts as an occurrence of the word (lower case) */
export function formsOf(w: PoolWord): string[] {
  const set = new Set<string>(matchForms(w.lemma, [...w.past, ...w.participle, ...own(IRREGULAR_PLURALS, w.lemma), ...own(EXTRA_VERB_FORMS, w.lemma)]));
  if (/adj/i.test(w.pos) || Object.hasOwn(IRREGULAR_COMPARATIVES, w.lemma)) for (const f of comparatives(w.lemma)) set.add(f);
  return [...set].filter((f) => /^[a-z]+(?:'[a-z]+)?$/.test(f));
}

/** spelling -> the pool lemmas it can belong to */
export function buildFormIndex(words: readonly PoolWord[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const w of words) {
    for (const f of formsOf(w)) {
      const list = index.get(f);
      if (!list) index.set(f, [w.lemma]);
      else if (!list.includes(w.lemma)) list.push(w.lemma);
    }
  }
  return index;
}

export interface Token {
  text: string;
  lower: string;
  start: number;
  length: number;
}

/** English words with their offsets; an apostrophe inside a word stays in it (don't, it's) */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const re = /[A-Za-z]+(?:'[A-Za-z]+)?/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ text: m[0], lower: m[0].toLowerCase(), start: m.index, length: m[0].length });
  return out;
}

export interface Match {
  lemma: string;
  start: number;
  length: number;
  surface: string;
  /** the spelling also belongs to another pool lemma */
  ambiguous: boolean;
}

/**
 * The pool lemmas a sentence contains. A lemma that occurs twice is dropped (a gap would leave the answer in the sentence); a capitalised word inside
 * the sentence is taken for a name and does not match.
 */
export function matchSentence(text: string, index: ReadonlyMap<string, readonly string[]>): Match[] {
  const found = new Map<string, Match[]>();
  const tokens = tokenize(text);
  tokens.forEach((t, i) => {
    if (i > 0 && /^[A-Z]/.test(t.text) && t.text !== "I") return;
    const lemmas = index.get(t.lower);
    if (!lemmas) return;
    for (const lemma of lemmas) {
      const list = found.get(lemma) ?? [];
      list.push({ lemma, start: t.start, length: t.length, surface: t.text, ambiguous: lemmas.length > 1 });
      found.set(lemma, list);
    }
  });
  return [...found.values()].filter((l) => l.length === 1).map((l) => l[0]!);
}
