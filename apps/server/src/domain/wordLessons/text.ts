/** An answer as it is stored: Unicode-normalised, spaces collapsed. Nothing else is changed (capitals, punctuation, articles stay as written). */
export function normalizeWordLessonText(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, " ").trim();
}
