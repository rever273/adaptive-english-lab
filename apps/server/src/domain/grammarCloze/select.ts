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

// ------------------------------------------------------------------------------------------------ cloze-select-v2: themed sessions

export const SELECT_VERSION_V2 = "cloze-select-v2";

/** grammar families: forms that are easy to confuse go together, so a session contrasts them instead of drilling one form */
export const FAMILIES: Record<string, { name: string; topics: string[] }> = {
  present: { name: "Present & future", topics: ["present_simple", "present_continuous", "future_simple"] },
  past: { name: "Past & perfect", topics: ["past_simple", "past_continuous", "present_perfect", "past_perfect"] },
  passive: { name: "Passive voice", topics: ["passive"] },
  modals: { name: "Modal verbs", topics: ["modals"] },
  conditionals: { name: "Conditionals", topics: ["conditionals"] },
  verbs: { name: "Verb patterns", topics: ["non_finites"] },
  determiners: { name: "Articles & quantifiers", topics: ["articles", "quantifiers"] },
  pronouns: { name: "Pronouns & possessives", topics: ["personal_pronouns", "possessives"] },
  clauses: { name: "Relatives & questions", topics: ["relatives", "wh_questions"] },
  comparisons: { name: "Comparisons", topics: ["comparisons"] },
  prepositions: { name: "Prepositions", topics: ["prepositions"] },
};
const TOPIC_FAMILY = new Map(Object.entries(FAMILIES).flatMap(([f, v]) => v.topics.map((t) => [t, f] as const)));
export const familyOf = (topic: string): string => TOPIC_FAMILY.get(topic) ?? "other";
export const familyName = (f: string): string => FAMILIES[f]?.name ?? "Mixed grammar";

export interface ThemedCandidate extends Candidate {
  family: string;
  /** the background check found this sentence unambiguous: preferred over unchecked ones */
  checked: boolean;
}
export interface SessionPlan {
  focus: string;
  review: string[];
}

/**
 * One session of `size` sentences in three parts (shares are design settings, not measured optima):
 *  - focus (~40%): one family, its rules interleaved (least planned rules first), so similar forms are contrasted;
 *  - review (~33%): NEW sentences of rules answered wrongly in recent sessions, then of the families focused in the last two sessions;
 *  - mix (the rest): one sentence each from other families, so the session never turns into a drill.
 * The focus family rotates: one not focused recently comes first. Checked sentences are taken before unchecked ones within a rule.
 * Then the order is shuffled with no more than two sentences of one rule in a row. Pure and deterministic for a seed.
 */
export function planThemedSession(o: {
  available: readonly ThemedCandidate[];
  history: ReadonlyMap<string, number>;
  /** focus families of earlier sessions, most recent first */
  recentFocus: readonly string[];
  /** wrong answers per rule in recent sessions */
  mistakes: ReadonlyMap<string, number>;
  size: number;
  seed: number;
}): { items: ThemedCandidate[]; plan: SessionPlan } {
  const rand = rng(o.seed);
  const n = Math.min(o.size, o.available.length);
  // family -> rule -> candidates (checked first, random otherwise)
  const byFamily = new Map<string, Map<string, ThemedCandidate[]>>();
  for (const c of [...o.available].sort((a, b) => (a.itemId < b.itemId ? -1 : 1))) {
    const rules = byFamily.get(c.family) ?? byFamily.set(c.family, new Map()).get(c.family)!;
    (rules.get(c.ruleKey) ?? rules.set(c.ruleKey, []).get(c.ruleKey)!).push(c);
  }
  for (const rules of byFamily.values()) for (const [k, list] of rules) rules.set(k, shuffle(list, rand).sort((a, b) => Number(b.checked) - Number(a.checked)));
  const sizeOf = (f: string): number => [...(byFamily.get(f)?.values() ?? [])].reduce((a, l) => a + l.length, 0);
  const picked: ThemedCandidate[] = [];
  const rulesOf = (f: string): string[] => {
    const rules = byFamily.get(f);
    if (!rules) return [];
    const keyed = [...rules.keys()].sort().map((k) => ({ k, h: o.history.get(k) ?? 0, r: rand() }));
    return keyed.sort((a, b) => a.h - b.h || a.r - b.r).map((x) => x.k);
  };
  const takeOne = (f: string, rule: string): boolean => {
    const list = byFamily.get(f)?.get(rule);
    if (!list || list.length === 0 || picked.length >= n) return false;
    picked.push(list.shift()!);
    return true;
  };
  /** round-robin over the family's rules, one sentence per rule per round */
  const takeFromFamily = (f: string, want: number): number => {
    let got = 0;
    const rules = rulesOf(f);
    for (let progress = true; got < want && progress; ) {
      progress = false;
      for (const r of rules) {
        if (got >= want) break;
        if (takeOne(f, r)) (got++, (progress = true));
      }
    }
    return got;
  };

  const focusWant = Math.round(n * 0.4);
  const reviewWant = Math.round(n * 0.33);
  // focus: never focused first, then the one focused longest ago; the family must fill its share
  const families = [...byFamily.keys()].sort().map((f) => ({ f, last: o.recentFocus.indexOf(f), r: rand() }));
  const eligible = families.filter((x) => x.f !== "other" && sizeOf(x.f) >= Math.min(focusWant, 4));
  const pool = eligible.length > 0 ? eligible : families;
  pool.sort((a, b) => (a.last === -1 ? Infinity : a.last) - (b.last === -1 ? Infinity : b.last) || a.r - b.r);
  const focus = pool.length > 0 ? pool[pool.length - 1]!.f : "other";
  // (sorted ascending by "how recent", so the least recent is last)
  takeFromFamily(focus, focusWant);

  // review: rules with recent mistakes (outside the focus), up to two new sentences each; then the last two focus families
  const review: string[] = [];
  let reviewGot = 0;
  const ruleFamily = new Map<string, string>();
  for (const [f, rules] of byFamily) for (const r of rules.keys()) ruleFamily.set(r, f);
  const missed = [...o.mistakes.entries()].filter(([r, m]) => m > 0 && ruleFamily.has(r) && ruleFamily.get(r) !== focus).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  for (const [r] of missed) {
    if (reviewGot >= reviewWant) break;
    const f = ruleFamily.get(r)!;
    let got = 0;
    while (got < 2 && reviewGot < reviewWant && takeOne(f, r)) (got++, reviewGot++);
    if (got > 0) review.push(r);
  }
  for (const f of o.recentFocus.slice(0, 2)) {
    if (reviewGot >= reviewWant || f === focus) continue;
    const before = picked.length;
    reviewGot += takeFromFamily(f, Math.min(reviewWant - reviewGot, 3));
    for (const c of picked.slice(before)) if (!review.includes(c.ruleKey)) review.push(c.ruleKey);
  }

  // mix: one sentence per other family (least planned families first), round after round
  const famHistory = (f: string): number => [...(byFamily.get(f)?.keys() ?? [])].reduce((a, r) => a + (o.history.get(r) ?? 0), 0);
  const others = [...byFamily.keys()].filter((f) => f !== focus).sort().map((f) => ({ f, h: famHistory(f), r: rand() })).sort((a, b) => a.h - b.h || a.r - b.r).map((x) => x.f);
  for (let progress = true; picked.length < n && progress; ) {
    progress = false;
    for (const f of others) {
      if (picked.length >= n) break;
      const rule = rulesOf(f).find((r) => (byFamily.get(f)!.get(r)?.length ?? 0) > 0);
      if (rule && takeOne(f, rule)) progress = true;
    }
  }
  // the focus family itself when nothing else is left
  if (picked.length < n) takeFromFamily(focus, n - picked.length);
  return { items: spreadRules(shuffle(picked, rand)) as ThemedCandidate[], plan: { focus, review } };
}
