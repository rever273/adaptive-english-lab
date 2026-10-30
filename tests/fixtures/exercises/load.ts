import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Exercise = Record<string, any>; // fixtures are plain JSON; the validator under test is what checks them

export const FIXTURE_NAMES = ["choose_form", "choose_missing_fragment", "detect_error", "detect_error_no_mistake", "guided_short_answer", "russian_to_english_short", "context_reading"] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

const dir = path.dirname(fileURLToPath(import.meta.url));
export const fixture = (name: FixtureName): Exercise => JSON.parse(readFileSync(path.join(dir, `${name}.json`), "utf8")) as Exercise;

/**
 * A copy with a new exercise id and every English sentence prefixed by `tag`, so no sentence repeats an earlier one.
 * (It stays "similar" to its source on purpose: tests that need near-duplicate quarantine rely on that.)
 */
export function uniq(name: FixtureName, tag: string): Exercise {
  const c = fixture(name);
  const t = (s: string) => `${tag} ${s}`;
  c.id = randomUUID();
  c.context_id = `${c.context_id}-${tag}`;
  c.template_cluster = `${c.template_cluster}-${tag}`;
  const p = c.payload;
  switch (c.type) {
    case "choose_form":
    case "choose_missing_fragment":
      c.prompt_en = t(c.prompt_en);
      break;
    case "detect_error":
      p.sentence = t(p.sentence);
      p.segments[0].text = t(p.segments[0].text);
      p.corrections = p.corrections.map(t);
      break;
    case "guided_short_answer":
    case "russian_to_english_short":
      p.accepted_answers = p.accepted_answers.map(t);
      break;
    case "context_reading":
      p.paragraphs = p.paragraphs.map(t);
      for (const q of p.questions) q.prompt = t(q.prompt);
      break;
  }
  return c;
}
