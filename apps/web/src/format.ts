/** Total time: seconds below a minute, minutes below an hour, hours and minutes up to 100 h, whole hours beyond that. */
export function fmtTotalTime(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s} s`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 100) return `${Math.round(s / 3600)} h`;
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** a word as it stands in a text, normalised like the server does when it looks saved words up */
export function normalizeBookWord(raw: string): string {
  return raw.normalize("NFKC").trim().toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
}

/**
 * Show only the first translation of a comma/semicolon-separated list ("согласовывать, примирять, сводить (счета)" →
 * "согласовывать"). Separators inside parentheses do not split.
 */
export function firstTranslation(text: string | null | undefined): string {
  if (!text) return "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === "," || c === ";" || c === "،" || c === "；")) return text.slice(0, i).trim();
  }
  return text.trim();
}
