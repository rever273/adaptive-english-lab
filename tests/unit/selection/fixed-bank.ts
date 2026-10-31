const FAMILIES = ["articles", "tenses", "verb_patterns", "prepositions", "questions", "modals", "conditionals", "passive"];
const DIM: Record<string, string> = { choose_form: "recognition", choose_missing_fragment: "recognition", detect_error: "correction", guided_short_answer: "production", russian_to_english_short: "production" };
/** a fixed, id-stable bank (no shared counter) so the expected sessions below are reproducible */
export function fixedBank() {
  const out: any[] = [];
  let id = 0;
  for (const [format, count] of Object.entries({ choose_form: 12, choose_missing_fragment: 12, detect_error: 12, guided_short_answer: 4, russian_to_english_short: 5 })) {
    for (let i = 0; i < count; i++) {
      id++;
      const family = FAMILIES[(i + id) % FAMILIES.length]!;
      out.push({ revisionId: `f${String(id).padStart(3, "0")}`, exerciseId: `fe${id}`, format, dimension: DIM[format], skillId: `${family}.skill${i % 3}`, family, contextId: `c${id}`, templateCluster: `t${id}`, bankRole: "practice", noMistake: format === "detect_error" && i % 4 === 0, childCount: 1, unitFingerprints: [`ffp-${id}-a`, `ffp-${id}-b`] });
    }
  }
  return out;
}
