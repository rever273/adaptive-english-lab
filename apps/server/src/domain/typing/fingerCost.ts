/**
 * How awkward a word is for touch typing on QWERTY with the standard finger placement (finger-cost-v1). Deterministic, no model:
 * home row is free, upper and lower rows cost more, sideways reaches of the index fingers and the little fingers cost extra, and
 * the same finger twice in a row on different keys (ed, ce, un, my) is the most expensive. Changing the hand is a small relief.
 */
export const FINGER_COST_VERSION = "finger-cost-v1";

/** fingers: 0 left little … 3 left index, 4 right index … 7 right little; rows: 0 upper, 1 home, 2 lower */
interface KeyPos {
  finger: number;
  row: 0 | 1 | 2;
  /** a sideways stretch of an index finger out of its home column */
  reach: boolean;
}

const LAYOUT: Record<string, KeyPos> = {};
const put = (keys: string, row: 0 | 1 | 2, fingers: number[], reach: string): void => {
  [...keys].forEach((k, i) => (LAYOUT[k] = { finger: fingers[i]!, row, reach: reach.includes(k) }));
};
put("qwertyuiop", 0, [0, 1, 2, 3, 3, 4, 4, 5, 6, 7], "ty");
put("asdfghjkl", 1, [0, 1, 2, 3, 3, 4, 4, 5, 6], "gh");
put("zxcvbnm", 2, [0, 1, 2, 3, 3, 4, 4], "bn");

const ROW_COST = [1, 0, 1.5] as const;
const REACH = 0.7;
const LITTLE = 0.8;
const RING = 0.3;
const SAME_FINGER = 2.5;
const SAME_FINGER_TWO_ROWS = 1;
const DOUBLE_LETTER = 0.3;
const ROW_JUMP = 1.5;
const HAND_CHANGE = -0.3;

const hand = (finger: number): 0 | 1 => (finger < 4 ? 0 : 1);

function keyCost(p: KeyPos): number {
  return ROW_COST[p.row] + (p.reach ? REACH : 0) + (p.finger === 0 || p.finger === 7 ? LITTLE : 0) + (p.finger === 1 || p.finger === 6 ? RING : 0);
}

function pairCost(a: string, b: string, pa: KeyPos, pb: KeyPos): number {
  if (a === b) return DOUBLE_LETTER;
  if (pa.finger === pb.finger) return SAME_FINGER + (Math.abs(pa.row - pb.row) === 2 ? SAME_FINGER_TWO_ROWS : 0);
  if (hand(pa.finger) !== hand(pb.finger)) return HAND_CHANGE;
  return Math.abs(pa.row - pb.row) === 2 ? ROW_JUMP : 0;
}

/** cost per letter of a lowercase a-z word (null for anything else); comparable between words of different lengths */
export function fingerCost(word: string): number | null {
  if (!/^[a-z]+$/.test(word)) return null;
  let total = 0;
  for (let i = 0; i < word.length; i++) {
    const p = LAYOUT[word[i]!]!;
    total += keyCost(p);
    if (i > 0) total += pairCost(word[i - 1]!, word[i]!, LAYOUT[word[i - 1]!]!, p);
  }
  return Math.round((total / word.length) * 1000) / 1000;
}

export interface DrillStage {
  /** keys open at this stage */
  keys: string;
  minLen: number;
  maxLen: number;
  /** highest typing word bank difficulty (2 = most common); personal vocabulary words ignore it */
  maxDifficulty: number;
}

const HOME = "asdfghjkl";
/** nested stages: every word of a stage stays allowed in the later ones */
export const DRILL_STAGES: readonly DrillStage[] = [
  { keys: HOME + "eiru", minLen: 3, maxLen: 5, maxDifficulty: 2 },
  { keys: HOME + "eiruto", minLen: 3, maxLen: 5, maxDifficulty: 2 },
  { keys: HOME + "eirutoywnmp", minLen: 3, maxLen: 6, maxDifficulty: 3 },
  { keys: HOME + "eirutoywnmpcvb", minLen: 3, maxLen: 7, maxDifficulty: 3 },
  { keys: "abcdefghijklmnopqrstuvwxyz", minLen: 3, maxLen: 8, maxDifficulty: 4 },
  { keys: "abcdefghijklmnopqrstuvwxyz", minLen: 3, maxLen: 12, maxDifficulty: 5 },
];

/** the first stage (1-based) that allows the word, or null when none does */
export function stageOf(word: string, difficulty: number | null): number | null {
  if (!/^[a-z]+$/.test(word)) return null;
  for (let i = 0; i < DRILL_STAGES.length; i++) {
    const s = DRILL_STAGES[i]!;
    if (word.length < s.minLen || word.length > s.maxLen) continue;
    if (difficulty !== null && difficulty > s.maxDifficulty) continue;
    if ([...word].every((c) => s.keys.includes(c))) return i + 1;
  }
  return null;
}
