import type { ExerciseType } from "@english-lab/contracts";

/** One concrete sentence a cheap model can be asked about, and what we EXPECT of it if the draft is sound. */
export interface ScreenSentence {
  /** key: should read as correct English. distractor: should read as wrong (a gap filled with a wrong option, the sentence with the error). */
  role: "key" | "distractor";
  label: string;
  text: string;
}

export const MAX_SCREEN_SENTENCES = 10;

const GAP = /_{2,}/;
const splitSentences = (para: string): string[] => para.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 3);

/**
 * Turns a stored draft into the sentences to check. The idea is cheap and objective: a sound multiple-choice item has exactly one option that
 * makes a correct sentence, so the key sentence should read as correct and every distractor sentence should read as wrong. A distractor
 * that also reads fine is the classic defect ("the team is/are"). This only produces HINTS for the human reviewer.
 */
export function screenSentences(type: ExerciseType, content: { prompt_en: string; payload: Record<string, any> }): ScreenSentence[] {
  const p = content.payload;
  const out: ScreenSentence[] = [];
  switch (type) {
    case "choose_form":
    case "choose_missing_fragment": {
      const accepted = new Set<string>(p.accepted_option_ids ?? []);
      for (const o of p.options as Array<{ id: string; text: string }>) out.push({ role: accepted.has(o.id) ? "key" : "distractor", label: `option ${o.id}`, text: content.prompt_en.replace(GAP, o.text).replace(/\s+/g, " ").trim() });
      break;
    }
    case "detect_error":
      if (p.no_mistake) out.push({ role: "key", label: "sentence (no mistake)", text: p.sentence });
      else {
        out.push({ role: "distractor", label: "original sentence", text: p.sentence });
        for (const c of (p.corrections as string[]) ?? []) out.push({ role: "key", label: "correction", text: c });
      }
      break;
    case "guided_short_answer":
    case "russian_to_english_short":
      for (const [i, a] of (p.accepted_answers as string[]).entries()) out.push({ role: "key", label: `accepted answer ${i + 1}`, text: a });
      break;
    case "context_reading":
      for (const [i, para] of (p.paragraphs as string[]).entries()) for (const [k, s] of splitSentences(para).entries()) out.push({ role: "key", label: `paragraph ${i + 1} sentence ${k + 1}`, text: s });
      for (const q of p.questions as Array<{ prompt: string }>) out.push({ role: "key", label: "question", text: q.prompt });
      break;
  }
  return out.slice(0, MAX_SCREEN_SENTENCES);
}

export interface ScreenFlag {
  code: "KEY_LOOKS_WRONG" | "DISTRACTOR_LOOKS_OK";
  label: string;
  text: string;
  score: number;
}

/** Fixed rules over raw scores. `score` = the model's weight on "something may be wrong" (0 = reads fine, 1 = looks wrong). */
export function flagsFor(sentences: ScreenSentence[], scores: number[], t: { keyWrongAtLeast: number; distractorOkBelow: number }): ScreenFlag[] {
  const flags: ScreenFlag[] = [];
  sentences.forEach((s, i) => {
    const score = scores[i]!;
    if (s.role === "key" && score >= t.keyWrongAtLeast) flags.push({ code: "KEY_LOOKS_WRONG", label: s.label, text: s.text, score });
    if (s.role === "distractor" && score < t.distractorOkBelow) flags.push({ code: "DISTRACTOR_LOOKS_OK", label: s.label, text: s.text, score });
  });
  return flags;
}
