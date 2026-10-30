/**
 * Finding a saved word in exercise text. There is no NLP library on this machine, so the match is deliberately plain and explainable:
 * whole words, case-insensitive, for the lemma, for every form the learner actually selected, and for the regular English endings of the lemma
 * (-s -es -ed -d -ing, y->ies/ied, silent e dropped before -ing, doubled final consonant). Irregular forms (go -> went) are only found when the
 * learner saved them as a selected form. This under-counts rather than over-counts, and a test pins the rules.
 */
export function normalizeWord(raw: string): string {
  return raw.normalize("NFKC").trim().toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "").replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ");
}

/** a saved item is a word or a short phrase of at most 4 words made of letters, apostrophes and hyphens */
export function isValidWord(w: string): boolean {
  return /^[\p{L}][\p{L}'\-]*(?: [\p{L}][\p{L}'\-]*){0,3}$/u.test(w) && w.length <= 60;
}

const VOWELS = /[aeiou]/;
export function regularForms(lemma: string): string[] {
  const out = new Set<string>([lemma]);
  const parts = lemma.split(" ");
  const head = parts[parts.length - 1]!; // inflect the last word of a phrase
  const prefix = parts.slice(0, -1).join(" ");
  const add = (f: string) => out.add(prefix ? `${prefix} ${f}` : f);
  if (!/^[a-z]+$/.test(head)) return [...out];
  add(`${head}s`);
  if (/(s|x|z|ch|sh|o)$/.test(head)) add(`${head}es`);
  if (/[^aeiou]y$/.test(head)) {
    add(`${head.slice(0, -1)}ies`);
    add(`${head.slice(0, -1)}ied`);
  }
  if (head.endsWith("e")) {
    add(`${head}d`);
    add(`${head.slice(0, -1)}ing`);
  } else {
    add(`${head}ed`);
    add(`${head}ing`);
    if (/[^aeiou][aeiou][^aeiouwxy]$/.test(head) && head.length <= 5 && VOWELS.test(head)) {
      add(`${head}${head.slice(-1)}ed`);
      add(`${head}${head.slice(-1)}ing`);
    }
  }
  return [...out];
}

/** every spelling that counts as an encounter of the entry */
export function matchForms(lemma: string, surfaceForms: readonly string[]): string[] {
  const set = new Set<string>(regularForms(normalizeWord(lemma)));
  for (const s of surfaceForms) {
    const n = normalizeWord(s);
    if (n) set.add(n);
  }
  return [...set].sort((a, b) => b.length - a.length);
}

/** number of whole-word occurrences of any form in the text (longest form first, no double counting of the same span) */
export function countOccurrences(text: string, forms: readonly string[]): number {
  if (forms.length === 0) return 0;
  const escaped = forms.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"));
  const re = new RegExp(`(?<![\\p{L}\\p{N}'-])(?:${escaped.join("|")})(?![\\p{L}\\p{N}'-])`, "giu");
  return (text.normalize("NFKC").replace(/[\u2018\u2019]/g, "'").match(re) ?? []).length;
}

type Payload = Record<string, any>;
/** English text an exercise SHOWS (prompt, options, sentence, passage, the question of a slot). Russian cues are not English vocabulary. */
export function shownTexts(content: { prompt_en: string; payload: Payload }, type: string, questionId: string | null): string[] {
  const p = content.payload;
  const out: string[] = [content.prompt_en];
  switch (type) {
    case "choose_form":
    case "choose_missing_fragment":
      out.push(...(p.options as Array<{ text: string }>).map((o) => o.text));
      break;
    case "detect_error":
      out.push(p.sentence as string);
      break;
    case "context_reading": {
      out.push(...(p.paragraphs as string[]));
      const qs = (p.questions as Array<{ id: string; prompt: string; options: Array<{ text: string }> }>).filter((q) => questionId === null || q.id === questionId);
      for (const q of qs) out.push(q.prompt, ...q.options.map((o) => o.text));
      break;
    }
    default:
      break;
  }
  return out.filter((t) => typeof t === "string");
}

/** everything in the approved exercise, including the accepted answers and corrections the learner sees afterwards: the BANK view */
export function bankTexts(content: { prompt_en: string; payload: Payload }, type: string): string[] {
  const p = content.payload;
  const out = shownTexts(content, type, null);
  if (type === "detect_error") out.push(...((p.corrections as string[]) ?? []));
  if (type === "guided_short_answer" || type === "russian_to_english_short") out.push(...((p.accepted_answers as string[]) ?? []));
  return out;
}
