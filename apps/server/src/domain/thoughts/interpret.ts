import type { Validated } from "../ai/validate.js";

const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN_WORD = /[A-Za-z]{2,}/;

export type ThoughtStatus = "ok" | "ambiguous" | "no_skill";

export interface Construction {
  /** the transferable pattern, abstract (no nouns of the original thought), e.g. "It would be + adjective + to-infinitive" */
  pattern: string;
  why_ru: string;
}

export interface Interpretation {
  status: ThoughtStatus;
  english: string;
  constructions: Construction[];
}

/** A construction after an agent chose the grammar skill it genuinely exercises (the model never chooses skills: it picked wrong ones in about half of the cases). */
export interface ConfirmedConstruction extends Construction {
  skill_id: string;
}

/** thought-interpret-v1: reads one Russian thought and proposes an English reading and reusable patterns. Output is a DRAFT for code and review. */
export const THOUGHT_SYSTEM_V1 = `You help ONE adult Russian-speaking learner of Australian English (level B2 to C1). You output JSON only, in the requested shape.
The learner wrote one thought in Russian. Fix obvious typos silently but never change what they mean.
1. english: one natural English sentence in everyday Australian English that says what they meant (not a word-for-word translation, no slang). If the meaning is unclear or could be read in clearly different ways, set status "ambiguous", english "" and constructions [].
2. constructions: one to three TRANSFERABLE grammar patterns that the English sentence really uses, written abstractly with no nouns of the thought (for example "It would be + adjective + to-infinitive"). Each pattern is the grammar of the sentence, never a topic or a vocabulary item.
3. If the sentence has no reusable grammar pattern (a greeting, a single word, a fixed phrase), set status "no_skill", keep english, and return constructions [].
4. why_ru: one short Russian sentence saying what the pattern is for. Do not name a grammar skill or category.
status is "ok" when english is clear and at least one pattern is given. Never invent facts that are not in the thought. Never output ids, scores or any field that is not in the shape.`;

export function thoughtFormat(): object {
  const str = (max: number) => ({ type: "string", maxLength: max });
  const construction = { type: "object", additionalProperties: false, required: ["pattern", "why_ru"], properties: { pattern: str(100), why_ru: str(200) } };
  return {
    type: "object",
    additionalProperties: false,
    required: ["status", "english", "constructions"],
    properties: { status: { type: "string", enum: ["ok", "ambiguous", "no_skill"] }, english: str(240), constructions: { type: "array", maxItems: 3, items: construction } },
  };
}

/** Everything the model returns is checked by code: a result with no usable pattern is "no_skill", not "ok". Skills are chosen later by an agent. */
export function validateInterpretation(text: string): Validated<Interpretation> {
  const bad = (code: string, message: string): Validated<Interpretation> => ({ ok: false, value: null, issues: [{ code, message }] });
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return bad("NOT_JSON", "the output is not one JSON document");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return bad("NOT_AN_OBJECT", "expected one JSON object");
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !["status", "english", "constructions"].includes(k));
  if (extra.length) return bad("UNEXPECTED_FIELD", `not part of the shape: ${extra.join(", ")}`);
  if (o.status !== "ok" && o.status !== "ambiguous" && o.status !== "no_skill") return bad("BAD_STATUS", 'status must be "ok", "ambiguous" or "no_skill"');
  const english = typeof o.english === "string" ? o.english.trim() : "";
  const list = Array.isArray(o.constructions) ? o.constructions : null;
  if (list === null) return bad("NO_CONSTRUCTIONS", "constructions must be an array");
  if (o.status === "ambiguous") return { ok: true, value: { status: "ambiguous", english: "", constructions: [] }, issues: [] };
  if (CYRILLIC.test(english) || !LATIN_WORD.test(english) || english.split(/\s+/).length < 3) return bad("NOT_ENGLISH", "english must be one English sentence");
  const kept: Construction[] = [];
  for (const raw of list) {
    const c = raw as Partial<Construction>;
    const pattern = typeof c.pattern === "string" ? c.pattern.trim() : "";
    const why = typeof c.why_ru === "string" ? c.why_ru.trim() : "";
    if (!pattern || CYRILLIC.test(pattern) || !LATIN_WORD.test(pattern)) return bad("BAD_PATTERN", "each pattern must be written in English");
    if (!why || !CYRILLIC.test(why)) return bad("NOT_RUSSIAN", "why_ru must be written in Russian");
    if (kept.some((k) => k.pattern.toLowerCase() === pattern.toLowerCase())) continue;
    kept.push({ pattern, why_ru: why });
  }
  return { ok: true, value: { status: o.status === "ok" && kept.length > 0 ? "ok" : "no_skill", english, constructions: kept }, issues: [] };
}
