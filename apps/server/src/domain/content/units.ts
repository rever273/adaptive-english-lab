import type { PromptUnitFingerprint } from "@english-lab/contracts";
import { BLANK, fingerprintOf, isSentenceUnit, markBlanks, normalizeSentence, splitSentences } from "./normalize.js";

interface Option {
  id: string;
  text: string;
}
interface Exercise {
  type: string;
  prompt_en: string;
  payload: Record<string, unknown>;
}

type Role = PromptUnitFingerprint["role"];

/**
 * Sentence units the backend fingerprints (spec/04 "No-repeat нормализация", spec/05 invariant 7).
 * Fragments, UI instructions and Russian text are not sentence units. For blank tasks the whole prompt is one unit with a
 * stable BLANK marker, plus the full sentence restored from every accepted fragment. The model never decides what counts.
 */
export function extractUnits(ex: Exercise): PromptUnitFingerprint[] {
  const raw: Array<{ role: Role; text: string }> = [];
  const add = (role: Role, text: string) => raw.push({ role, text });
  const p = ex.payload;

  switch (ex.type) {
    case "choose_form":
    case "choose_missing_fragment": {
      const options = (p.options as Option[]) ?? [];
      const accepted = new Set((p.accepted_option_ids as string[]) ?? []);
      const hasBlank = markBlanks(ex.prompt_en).includes(BLANK);
      if (hasBlank) {
        add("prompt", ex.prompt_en);
        for (const o of options) {
          if (!accepted.has(o.id)) continue;
          add("answer", markBlanks(ex.prompt_en).replace(BLANK, o.text)); // the sentence the learner will see when correct
        }
      }
      for (const o of options) add("option", o.text); // kept only if it is itself a full sentence
      break;
    }
    case "detect_error": {
      add("prompt", String(p.sentence ?? ""));
      for (const c of (p.corrections as string[]) ?? []) add("answer", c);
      break;
    }
    case "guided_short_answer":
    case "russian_to_english_short": {
      for (const a of (p.accepted_answers as string[]) ?? []) add("answer", a);
      break;
    }
    case "context_reading": {
      for (const para of (p.paragraphs as string[]) ?? []) for (const s of splitSentences(para)) add("passage", s);
      for (const q of (p.questions as Array<{ prompt: string; options: Option[] }>) ?? []) {
        add("prompt", q.prompt);
        for (const o of q.options) add("option", o.text);
      }
      break;
    }
  }

  const seen = new Set<string>();
  const out: PromptUnitFingerprint[] = [];
  const ordinals = new Map<Role, number>();
  for (const r of raw) {
    const text = normalizeSentence(r.text);
    if (!isSentenceUnit(text)) continue;
    const fp = fingerprintOf(text);
    const key = `${r.role}|${fp}`;
    if (seen.has(key)) continue; // same unit twice in one role is one unit
    seen.add(key);
    const ordinal = ordinals.get(r.role) ?? 0;
    ordinals.set(r.role, ordinal + 1);
    out.push({ role: r.role, ordinal, text, fingerprint: fp });
  }
  return out;
}
