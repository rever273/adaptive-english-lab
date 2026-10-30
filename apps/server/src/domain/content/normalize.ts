import { createHash } from "node:crypto";

export const NORMALIZER_VERSION = "norm-v1";
export const BLANK = "⟦BLANK⟧";
/** A prompt/option/answer counts as a sentence unit only from this many words; fragments such as "to" never do (spec/04). */
export const MIN_SENTENCE_WORDS = 3;

const QUOTES: Array<[RegExp, string]> = [
  [/[‘’‚‛′´`]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐‑‒–—―−]/g, "-"],
];

/** Blank markers (___ , … runs, [blank]) become one stable marker before normalising. */
export function markBlanks(text: string): string {
  return text.replace(/_{2,}|\[\s*blank\s*\]|\.{3,}\s*(?=\W|$)/gi, BLANK);
}

/**
 * norm-v1 (spec/04): Unicode NFKC, casefold, typographic quote/dash normalisation, whitespace collapse, terminal
 * punctuation removal. Negations, numbers and articles are never stripped.
 */
export function normalizeSentence(text: string): string {
  let s = markBlanks(text).normalize("NFKC");
  for (const [re, to] of QUOTES) s = s.replace(re, to);
  s = s.toLowerCase().replace(/\s+/g, " ").trim();
  s = s.replace(/[\s.!?…]+$/u, "");
  return s.trim();
}

export const fingerprintOf = (normalized: string): string => createHash("sha256").update(normalized, "utf8").digest("hex");

export function wordTokens(normalized: string): string[] {
  return normalized.replace(BLANK.toLowerCase(), " blank ").match(/[\p{L}\p{N}']+/gu) ?? [];
}

export const isSentenceUnit = (normalized: string): boolean => wordTokens(normalized).length >= MIN_SENTENCE_WORDS;

/** Splits running text (a reading passage) into sentences; abbreviations are not special-cased on purpose. */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'“‘])/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function trigrams(normalized: string): Set<string> {
  const t = wordTokens(normalized);
  const out = new Set<string>();
  if (t.length < 3) {
    if (t.length > 0) out.add(t.join(" "));
    return out;
  }
  for (let i = 0; i + 2 < t.length; i++) out.add(`${t[i]} ${t[i + 1]} ${t[i + 2]}`);
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export const NEAR_DUPLICATE_THRESHOLD = 0.8;

/** Stable key order, so equal content always hashes equally regardless of how the generator ordered fields. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export const contentHashOf = (content: unknown): string => createHash("sha256").update(canonicalJson(content), "utf8").digest("hex");
