import { ApiError } from "../../errors.js";
import type { Assessor, AssessContext, AssessmentDecision } from "../attempts/ports.js";

/** `detect_error` answer meaning "the sentence is correct"; a distinct UI action from "I don't know" (spec/05 invariant 2). */
export const NO_MISTAKE_ID = "__no_mistake__";

const QUOTES: Array<[RegExp, string]> = [
  [/[‘’‚‛′´`]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐‑‒–—―−]/g, "-"],
];

/**
 * Comparison form of a free-text answer (spec/05 invariant 5): Unicode NFKC, typographic quotes/dashes, whitespace and a
 * terminal full stop / question / exclamation mark are normalised. Negation, articles and every other word are kept, and
 * no fuzzy matching exists. Letter case is ignored only at comparison time (answerKey, D62).
 */
export function normalizeAnswerText(text: string): string {
  let s = text.normalize("NFKC");
  for (const [re, to] of QUOTES) s = s.replace(re, to);
  return s.replace(/\s+/g, " ").trim().replace(/[.!?]+$/u, "").trim();
}

/** What is actually compared: the normalised text, case-folded (D62: capital letters never decide correctness). */
export const answerKey = (text: string): string => normalizeAnswerText(text).toLocaleLowerCase("en");

const setKey = (ids: readonly string[]): string => [...new Set(ids)].sort().join("\u0000");
const confirmed = (verdict: "correct" | "incorrect", rationale: string): AssessmentDecision => ({ verdict, confirmation: "confirmed", source: "deterministic", rationale });

type Content = { payload: Record<string, unknown> };

/**
 * Closed-form grader (spec/04): choose_form / choose_missing_fragment / detect_error / reading questions are graded by exact
 * set equality; short answers are accepted only on an exact match with an approved alternative. Anything else is NEVER
 * marked wrong by code: it stays pending for a later model/human check, with a queue descriptor. No model is called here.
 */
export const ClosedFormAssessor: Assessor = {
  assess(ctx: AssessContext): AssessmentDecision {
    if (ctx.idk) return { verdict: "idk", confirmation: "confirmed", source: "deterministic", rationale: "User chose \"I don't know\"." };
    const content = ctx.content as Content;
    const raw = ctx.rawAnswer as { kind: string; optionIds?: string[]; text?: string };

    switch (ctx.exerciseType) {
      case "choose_form":
      case "choose_missing_fragment": {
        const ids = needOptions(raw);
        const options = new Set((content.payload.options as Array<{ id: string }>).map((o) => o.id));
        const ok = ids.every((i) => options.has(i)) && setKey(ids) === setKey(content.payload.accepted_option_ids as string[]);
        return confirmed(ok ? "correct" : "incorrect", ok ? "Exact match with the accepted options." : "Selection differs from the accepted options.");
      }
      case "detect_error": {
        const ids = needOptions(raw);
        const p = content.payload as { no_mistake: boolean; accepted_segment_ids: string[]; segments: Array<{ id: string }> };
        if (ids.length === 1 && ids[0] === NO_MISTAKE_ID) {
          return confirmed(p.no_mistake ? "correct" : "incorrect", p.no_mistake ? "Correctly identified a sentence with no mistake." : "The sentence does contain a mistake.");
        }
        if (ids.includes(NO_MISTAKE_ID)) throw new ApiError(422, "ANSWER_SHAPE_INVALID", "\"No mistake\" cannot be combined with a segment");
        const segs = new Set(p.segments.map((s) => s.id));
        const ok = !p.no_mistake && ids.every((i) => segs.has(i)) && setKey(ids) === setKey(p.accepted_segment_ids);
        return confirmed(ok ? "correct" : "incorrect", ok ? "Exact match with the faulty segment(s)." : p.no_mistake ? "The sentence has no mistake." : "Selected segment(s) differ from the faulty one(s).");
      }
      case "context_reading": {
        const ids = needOptions(raw);
        const q = (content.payload.questions as Array<{ id: string; options: Array<{ id: string }>; accepted_option_ids: string[] }>).find((x) => x.id === ctx.questionId);
        if (!q) throw new ApiError(422, "ANSWER_SHAPE_INVALID", "Unknown reading question for this slot");
        const ok = ids.every((i) => q.options.some((o) => o.id === i)) && setKey(ids) === setKey(q.accepted_option_ids);
        return confirmed(ok ? "correct" : "incorrect", ok ? "Exact match with the accepted options." : "Selection differs from the accepted options.");
      }
      case "guided_short_answer":
      case "russian_to_english_short": {
        if (raw.kind !== "text" || typeof raw.text !== "string") throw new ApiError(422, "ANSWER_SHAPE_INVALID", "This format needs a written answer");
        const given = answerKey(raw.text);
        const accepted = (content.payload.accepted_answers as string[]).map(answerKey);
        if (given.length > 0 && accepted.includes(given)) return confirmed("correct", "Exact match with an approved alternative.");
        return {
          verdict: "pending",
          confirmation: "tentative",
          source: "deterministic",
          rationale: "Not an approved alternative: saved for review, not judged wrong by code.",
          outbox: { kind: "free_text_analysis", payload: { slotId: ctx.slotId, attemptId: ctx.attemptId } },
        };
      }
      default:
        throw new ApiError(422, "ANSWER_SHAPE_INVALID", `Unknown exercise type ${ctx.exerciseType}`);
    }
  },
};

function needOptions(raw: { kind: string; optionIds?: string[] }): string[] {
  if (raw.kind !== "options" || !raw.optionIds) throw new ApiError(422, "ANSWER_SHAPE_INVALID", "This format needs a selection of option IDs");
  return raw.optionIds;
}
