import { isContractionToken } from "@english-lab/contracts";
import { alignWords, rawTokens } from "./check.js";

/**
 * What kind of mistake a wrong dictation answer contains, found by comparing the typed words with the sentence (no AI). It is an approximation: a written
 * answer cannot say what was misheard, and it never changes Grammar Mastery. Only the first answer of a sentence is classified.
 */
export const ERROR_TYPES = ["articles", "auxiliary_verbs", "prepositions", "word_endings", "contractions", "vocabulary", "word_order", "missing_word", "extra_word"] as const;
export type ErrorType = (typeof ERROR_TYPES)[number];

export const ERROR_TYPE_LABEL: Record<ErrorType, string> = {
  articles: "Articles (a / an / the)",
  auxiliary_verbs: "Auxiliary verbs (do / have / was)",
  prepositions: "Prepositions (in / on / at / for)",
  word_endings: "Word endings (work / worked / works)",
  contractions: "Contractions (he's / he is)",
  vocabulary: "Wrong word",
  word_order: "Word order",
  missing_word: "Missing word",
  extra_word: "Extra word",
};

const ARTICLES = new Set(["a", "an", "the"]);
const AUXILIARIES = new Set(["do", "does", "did", "have", "has", "had", "am", "is", "are", "was", "were", "be", "been", "being", "will", "would", "can", "could", "should", "shall", "may", "might", "must"]);
const PREPOSITIONS = new Set(["in", "on", "at", "for", "to", "of", "with", "by", "from", "about", "into", "over", "under", "between", "through", "during", "before", "after", "since", "until", "off", "up", "down", "out", "across", "around", "against", "without", "within", "onto", "towards", "along"]);
const ENDINGS = ["y", "s", "es", "ed", "d", "ing", "er", "est", "ly", "ies", "ied", "ier", "iest", "ness", "ment"];

/** the same stem with another ending ("work" / "worked", "carry" / "carried") */
export function sameStem(a: string, b: string): boolean {
  if (a === b || Math.min(a.length, b.length) < 3) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  // longest common prefix; what is left of each side must look like an ending
  let k = 0;
  while (k < short.length && short[k] === long[k]) k++;
  if (k < 3 || k < short.length * 0.6) return false;
  const restShort = short.slice(k);
  const restLong = long.slice(k);
  const ending = (r: string) => r === "" || ENDINGS.includes(r) || ENDINGS.some((e) => r.endsWith(e) && r.length <= e.length + 1);
  return ending(restShort) && ending(restLong);
}

/** the type a word alone points to (an article, a helper verb, a preposition, a contraction), or null for an ordinary word */
function typeOfWord(w: string): ErrorType | null {
  if (ARTICLES.has(w)) return "articles";
  if (isContractionToken(w)) return "contractions";
  if (AUXILIARIES.has(w)) return "auxiliary_verbs";
  if (PREPOSITIONS.has(w)) return "prepositions";
  return null;
}

/** one entry per mistake in the typed answer */
export function classifyAnswer(expected: string, typed: string): ErrorType[] {
  // raw words, not merged contractions: "they have" and "they had" must stay two different helper verbs
  const { ops } = alignWords(rawTokens(expected), rawTokens(typed));
  const missing: string[] = [];
  const extra: string[] = [];
  const out: ErrorType[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.op === "same") continue;
    const next = ops[i + 1];
    // two neighbouring wrong words that are each other's swap: the words are in the wrong order
    if (op.op === "wrong" && next?.op === "wrong" && op.expected === next.typed && op.typed === next.expected) {
      out.push("word_order");
      i++;
      continue;
    }
    if (op.op === "missing") missing.push(op.expected!);
    else if (op.op === "extra") extra.push(op.typed!);
    else {
      const e = op.expected!;
      const t = op.typed!;
      const te = typeOfWord(e);
      const tt = typeOfWord(t);
      if (sameStem(e, t)) out.push("word_endings");
      else if (te && te === tt) out.push(te);
      else if (te === "contractions" || tt === "contractions") out.push("contractions");
      else if (te === "articles" || tt === "articles") out.push("articles");
      else out.push("vocabulary");
    }
  }
  // the same word missing in one place and extra in another is a word in the wrong place
  for (const w of [...missing]) {
    const k = extra.indexOf(w);
    if (k >= 0) {
      extra.splice(k, 1);
      missing.splice(missing.indexOf(w), 1);
      out.push("word_order");
    }
  }
  for (const w of missing) out.push(typeOfWord(w) ?? "missing_word");
  for (const w of extra) out.push(typeOfWord(w) ?? "extra_word");
  return out;
}

export function errorTypeSummary(types: readonly ErrorType[]): Array<{ type: ErrorType; label: string; count: number; share: number }> {
  const counts = new Map<ErrorType, number>();
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
  const total = types.length;
  return ERROR_TYPES.filter((t) => counts.has(t))
    .map((type) => ({ type, label: ERROR_TYPE_LABEL[type], count: counts.get(type)!, share: Math.round((counts.get(type)! / total) * 1000) / 10 }))
    .sort((a, b) => b.count - a.count);
}
