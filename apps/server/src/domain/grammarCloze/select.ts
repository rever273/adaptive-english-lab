/**
 * Picking the sentences of one Grammar Cloze session (TASK_032 section 3.4, cloze-select-v1). Pure and deterministic for a seed.
 *  - only sentences still unanswered, not excluded and not reserved in this stage are offered (the caller filters);
 *  - rules that were planned LEAST in earlier sessions come first, whatever the number of sentences each rule has in the bank;
 *  - sentences of one rule come in groups of at least two (15 sentences: six groups of two and one of three), with sensible exceptions;
 *  - the order inside a session and the position of the right answer are shuffled.
 */
export const SELECT_VERSION = "cloze-select-v1";

export interface Candidate {
  itemId: string;
  ruleKey: string;
}

/** small seeded generator (mulberry32) */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle<T>(arr: readonly T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** the group sizes for n sentences: all pairs, the remainder joins the last group */
export function groupSizes(n: number): number[] {
  if (n <= 0) return [];
  if (n < 4) return [n];
  const g = Math.floor(n / 2);
  const sizes = Array<number>(g).fill(2);
  sizes[g - 1] = 2 + (n - 2 * g);
  return sizes;
}

export function planSession(o: { available: readonly Candidate[]; history: ReadonlyMap<string, number>; size: number; seed: number }): Candidate[] {
  const rand = rng(o.seed);
  const n = Math.min(o.size, o.available.length);
  if (n <= 0) return [];
  const byRule = new Map<string, Candidate[]>();
  for (const c of [...o.available].sort((a, b) => (a.itemId < b.itemId ? -1 : 1))) (byRule.get(c.ruleKey) ?? byRule.set(c.ruleKey, []).get(c.ruleKey)!).push(c);
  for (const [k, list] of byRule) byRule.set(k, shuffle(list, rand));
  // least planned first; random order among equals; rules with a single sentence wait until the pairs are placed
  const keyed = [...byRule.keys()].sort().map((k) => ({ k, h: o.history.get(k) ?? 0, r: rand() }));
  keyed.sort((a, b) => a.h - b.h || a.r - b.r);
  const order = [...keyed.filter((x) => byRule.get(x.k)!.length >= 2), ...keyed.filter((x) => byRule.get(x.k)!.length < 2)].map((x) => x.k);
  const taken = new Map<string, Candidate[]>();
  let left = n;
  const sizes = groupSizes(n);
  let gi = 0;
  const take = (k: string, want: number): void => {
    const avail = byRule.get(k)!;
    const t = Math.min(want, avail.length, left);
    if (t <= 0) return;
    taken.set(k, [...(taken.get(k) ?? []), ...avail.splice(0, t)]);
    left -= t;
  };
  for (const k of order) {
    if (left <= 0) break;
    if (gi >= sizes.length) break;
    const before = left;
    take(k, sizes[gi]!);
    if (before !== left) gi++;
  }
  // not enough rules or sentences for the groups: top up, pairs first, in the same order
  while (left > 0) {
    const had = left;
    for (const k of order) {
      if (left <= 0) break;
      take(k, 2);
    }
    if (left === had) break;
  }
  const picked = shuffle([...taken.values()].flat(), rand);
  return spreadRules(picked);
}

/** no more than two sentences of the same rule in a row, when the mix allows it */
export function spreadRules(list: Candidate[]): Candidate[] {
  const rest = [...list];
  const out: Candidate[] = [];
  while (rest.length > 0) {
    const l = out.length;
    const blocked = (c: Candidate): boolean => l >= 2 && out[l - 1]!.ruleKey === c.ruleKey && out[l - 2]!.ruleKey === c.ruleKey;
    // a rule that would be squeezed into the tail goes first (otherwise the greedy walk can corner itself)
    const tally = new Map<string, number>();
    for (const c of rest) tally.set(c.ruleKey, (tally.get(c.ruleKey) ?? 0) + 1);
    const [topRule, top] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]!;
    let idx = top * 3 >= rest.length * 2 - 1 && rest.length > 2 ? rest.findIndex((c) => c.ruleKey === topRule && !blocked(c)) : -1;
    if (idx < 0) idx = rest.findIndex((c) => !blocked(c));
    out.push(rest.splice(idx < 0 ? 0 : idx, 1)[0]!);
  }
  return out;
}

/**
 * Orders the options of each sentence: the right answer's position is spread evenly over the session and never the same more than twice in a row.
 * `items` are in session order; the result has the same order.
 */
export function orderOptions(items: ReadonlyArray<{ solution: string; distractors: readonly string[] }>, seed: number): string[][] {
  const rand = rng(seed ^ 0x9e3779b9);
  const queues = new Map<number, number[]>();
  const recent: number[] = [];
  return items.map((it) => {
    const k = it.distractors.length + 1;
    let q = queues.get(k) ?? [];
    if (q.length === 0) q = shuffle([...Array(k).keys()], rand);
    // avoid a third equal position in a row
    let idx = q.findIndex((p) => !(recent.length >= 2 && recent[recent.length - 1] === p && recent[recent.length - 2] === p));
    if (idx < 0) idx = 0;
    const pos = q.splice(idx, 1)[0]!;
    queues.set(k, q);
    recent.push(pos);
    const others = shuffle(it.distractors, rand);
    const out: string[] = [];
    for (let i = 0, d = 0; i < k; i++) out.push(i === pos ? it.solution : others[d++]!);
    return out;
  });
}
