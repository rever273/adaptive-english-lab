import { comparisonKey } from "./grader.js";

export interface Block {
  id: string;
  text: string;
}

/**
 * assemble_sentence (TASK_026): the learner orders ready-made blocks. A pure ordering of forms tests only word order, so only the skills below
 * may have no wrong block; every other skill needs at least one distractor block that breaks that skill's rule.
 */
export const ORDER_ONLY_SKILLS = new Set(["questions.direct_auxiliary", "questions.embedded_order"]);
export const mayHaveNoDistractor = (skill: string): boolean => skill.startsWith("word_order.") || ORDER_ONLY_SKILLS.has(skill);

/** The sentence a chosen order of blocks spells. Texts are joined with a single space; case and the final full stop are ignored when comparing. */
export const spell = (texts: readonly string[]): string => texts.join(" ").replace(/\s+/g, " ").trim();

/** True when `sentence` can be spelled by using every block text exactly once, in some order (a repeated block text is used as often as it occurs). */
export function spellsFrom(sentence: string, blockTexts: readonly string[]): boolean {
  const target = comparisonKey(sentence);
  const keys = blockTexts.map((t) => comparisonKey(t));
  if (keys.length > 10) return false;
  const used = new Array<boolean>(keys.length).fill(false);
  const go = (rest: string, left: number): boolean => {
    if (left === 0) return rest.trim() === "";
    for (let i = 0; i < keys.length; i++) {
      if (used[i]) continue;
      const k = keys[i]!;
      if (k === "") continue;
      if (rest === k || rest.startsWith(k + " ")) {
        used[i] = true;
        if (go(rest.slice(k.length).trim(), left - 1)) return true;
        used[i] = false;
      }
    }
    return false;
  };
  return go(target, keys.length);
}

/** Is the learner's chosen order one of the approved sentences? Ids must be known and used at most once. */
export function isApprovedOrder(chosenIds: readonly string[], blocks: readonly Block[], accepted: readonly string[]): boolean {
  const byId = new Map(blocks.map((b) => [b.id, b.text]));
  if (new Set(chosenIds).size !== chosenIds.length || chosenIds.some((id) => !byId.has(id))) return false;
  // every block is compared without its own final full stop, so a block that carries the full stop can sit in the middle of another approved order
  const given = chosenIds.map((id) => comparisonKey(byId.get(id)!)).join(" ");
  return accepted.some((a) => comparisonKey(a) === given);
}
