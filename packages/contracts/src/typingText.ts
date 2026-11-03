/**
 * Shared book-text handling for the typing games. Lives in contracts because both the client (which drives the input) and the
 * server (which counts `charsCorrect`) must derive the exact same required keys from the same text. Offsets are JS-string
 * indices into the prepared book text (UTF-8, LF, one blank line between paragraphs).
 */

/** Strip combining marks so a diacritic letter becomes its base form (`é` -> `e`). Ligatures are left as-is and are skipped. */
function baseChar(ch: string): string {
  return ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

const isLetter = (ch: string) => /[A-Za-z]/.test(baseChar(ch));
const isAlnum = (ch: string) => /[A-Za-z0-9]/.test(baseChar(ch));

/** Required punctuation: always typed when it appears. */
const REQUIRED_PUNCT = ".,?!:;";

/**
 * The key the user must press for one character, or null when the character is skipped automatically.
 * Letters are returned lower-case (input is case-insensitive); digits, space and required punctuation return themselves.
 */
export function requiredKeyOf(ch: string): string | null {
  if (!ch) return null;
  const base = baseChar(ch);
  if (!base) return null;
  const c = base.charAt(0);
  if (/[A-Za-z]/.test(c)) return c.toLowerCase();
  if (/[0-9]/.test(c)) return c;
  if (c === " ") return " ";
  if (REQUIRED_PUNCT.includes(c)) return c;
  if (c === "-") return "-";
  return null;
}

/**
 * Required keys of a single sentence range `[start, end)`. A range is expected to have no internal sentence boundary
 * (sentence separators are handled by `splitSentences`): within it every space between words is typed, and spaces around
 * skipped symbols collapse into one. A dash without spaces around it (`word—word`) yields one required space. Leading
 * whitespace and any trailing pending space are dropped.
 */
export function buildKeys(text: string, start: number, end: number): Array<{ offset: number; key: string }> {
  const keys: Array<{ offset: number; key: string }> = [];
  let pendingSpaceOffset = -1;
  const flushSpace = () => {
    if (pendingSpaceOffset < 0) return;
    if (keys.length > 0) keys.push({ offset: pendingSpaceOffset, key: " " });
    pendingSpaceOffset = -1;
  };
  for (let i = start; i < end; i++) {
    const ch = text.charAt(i);
    const base = baseChar(ch);
    if (/[A-Za-z]/.test(base)) {
      flushSpace();
      keys.push({ offset: i, key: base.toLowerCase() });
      continue;
    }
    if (/[0-9]/.test(base)) {
      flushSpace();
      keys.push({ offset: i, key: base });
      continue;
    }
    if (ch === " ") {
      if (pendingSpaceOffset < 0) pendingSpaceOffset = i;
      continue;
    }
    if (REQUIRED_PUNCT.includes(ch)) {
      flushSpace();
      keys.push({ offset: i, key: ch });
      continue;
    }
    if (ch === "-") {
      const prev = i > start ? text.charAt(i - 1) : undefined;
      const next = i + 1 < end ? text.charAt(i + 1) : undefined;
      if (prev && next && isLetter(prev) && isLetter(next)) {
        flushSpace();
        keys.push({ offset: i, key: "-" });
      }
      // a dash used as a separator is skipped like any other skip symbol
      continue;
    }
    if (ch === "—" || ch === "–") {
      const prev = i > start ? text.charAt(i - 1) : undefined;
      const next = i + 1 < end ? text.charAt(i + 1) : undefined;
      if (prev && next && isAlnum(prev) && isAlnum(next)) {
        // dash without surrounding spaces implies a single required space
        if (pendingSpaceOffset < 0) pendingSpaceOffset = i;
      }
      continue;
    }
    // every other character (quotes, brackets, asterisks, ellipsis, newlines, ...) is skipped; surrounding spaces collapse via pendingSpace
  }
  return keys;
}

export interface TypingToken {
  startOffset: number;
  endOffset: number;
  keys: Array<{ offset: number; key: string }>;
}

/** A token starts at a word and runs through the trailing required punctuation; skipped quotes/brackets belong to it. */
export function tokensOf(text: string, sentence: { start: number; end: number }): TypingToken[] {
  const tokens: TypingToken[] = [];
  let i = sentence.start;
  const end = sentence.end;
  while (i < end) {
    if (!isAlnum(text.charAt(i))) {
      i++;
      continue;
    }
    let j = i;
    while (j < end) {
      const c = text.charAt(j);
      if (isAlnum(c) || c === "-" || c === "'" || c === "’") {
        j++;
        continue;
      }
      break;
    }
    while (j < end) {
      const c = text.charAt(j);
      if (REQUIRED_PUNCT.includes(c) || c === ")" || c === "]" || c === "'" || c === "’" || c === "\"" || c === "”" || c === "’") {
        j++;
        continue;
      }
      break;
    }
    const keys = buildKeys(text, i, j);
    if (keys.length > 0) tokens.push({ startOffset: i, endOffset: j, keys });
    i = j;
  }
  return tokens;
}

/** Sentence ranges over the whole text, trailing whitespace trimmed and abbreviations (Mr. / Mrs. / Dr. / St. / Mt.) merged. */
const ABBREVIATIONS = new Set(["Mr", "Mrs", "Ms", "Dr", "St", "Mt"]);

export function splitSentences(text: string): Array<{ start: number; end: number }> {
  const seg = new Intl.Segmenter("en", { granularity: "sentence" });
  const raw: Array<{ start: number; end: number }> = [];
  for (const { index, segment } of seg.segment(text)) {
    let s = index;
    let e = index + segment.length;
    while (s < e && /\s/.test(text.charAt(s))) s++;
    while (e > s && /\s/.test(text.charAt(e - 1))) e--;
    if (e > s) raw.push({ start: s, end: e });
  }
  const out: Array<{ start: number; end: number }> = [];
  for (const s of raw) {
    const prev = out[out.length - 1];
    if (prev && endsWithAbbreviation(text, prev)) prev.end = s.end;
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

function endsWithAbbreviation(text: string, s: { start: number; end: number }): boolean {
  let e = s.end;
  while (e > s.start && !isAlnum(text.charAt(e - 1))) e--;
  let w = e;
  while (w > s.start && isAlnum(text.charAt(w - 1))) w--;
  const word = text.slice(w, e);
  const bare = word.endsWith(".") ? word.slice(0, -1) : word;
  return ABBREVIATIONS.has(bare);
}

/** Number of required keys in `[start, end)`, counting sentence separators correctly (client and server agree by construction). */
export function countRequired(text: string, start: number, end: number): number {
  let total = 0;
  for (const s of splitSentences(text)) {
    if (s.end <= start) continue;
    if (s.start >= end) break;
    total += buildKeys(text, Math.max(s.start, start), Math.min(s.end, end)).length;
  }
  return total;
}
