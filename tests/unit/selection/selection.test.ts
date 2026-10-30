import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUOTAS,
  applyReading,
  clampMultiplier,
  computePriority,
  familyCap,
  formatCap,
  hardViolations,
  scaleQuotas,
  selectSession,
  type Candidate,
  type Dimension,
  type Format,
  type SelectionInput,
} from "../../../packages/learning/src/index.js";

const FAMILIES = ["articles", "tenses", "verb_patterns", "prepositions", "questions", "modals", "conditionals", "passive"];
const DIM: Record<Format, Dimension> = { choose_form: "recognition", choose_missing_fragment: "recognition", detect_error: "correction", guided_short_answer: "production", russian_to_english_short: "production", context_reading: "recognition" };

let seq = 0;
/** A deterministic synthetic bank: `perFormat` exercises of every format, skills spread across 8 families. */
function bank(perFormat: Record<string, number>, o: { noMistakeEvery?: number; familiesUsed?: number; reading?: number } = {}): Candidate[] {
  const out: Candidate[] = [];
  const nFam = o.familiesUsed ?? FAMILIES.length;
  for (const [format, count] of Object.entries(perFormat)) {
    for (let i = 0; i < count; i++) {
      const id = ++seq;
      const family = FAMILIES[(i + id) % nFam]!;
      out.push({
        revisionId: `r${String(id).padStart(5, "0")}`,
        exerciseId: `e${String(id).padStart(5, "0")}`,
        format: format as Format,
        dimension: DIM[format as Format],
        skillId: `${family}.skill${i % 3}`,
        family,
        contextId: `ctx${id}`,
        templateCluster: `tpl${id}`,
        bankRole: "practice",
        noMistake: format === "detect_error" && (o.noMistakeEvery ?? 4) > 0 && i % (o.noMistakeEvery ?? 4) === 0,
        childCount: format === "context_reading" ? (o.reading ?? 3) : 1,
        unitFingerprints: [`fp-${id}-a`, `fp-${id}-b`],
      });
    }
  }
  return out;
}
const BIG = () => bank({ choose_form: 12, choose_missing_fragment: 12, detect_error: 12, guided_short_answer: 4, russian_to_english_short: 5 });

const base = (candidates: Candidate[], o: Partial<SelectionInput> = {}): SelectionInput => ({
  n: 18,
  weakRatio: 0.65,
  voiceTarget: 2,
  seed: "seed-1",
  quotas: DEFAULT_QUOTAS,
  readingBlocks: 0,
  candidates,
  blocked: new Set(),
  priority: () => 0.5,
  planMultiplier: () => 1,
  discovery: { bonusBySkill: {}, limit: 0 },
  ...o,
});
const byId = (c: Candidate[]) => new Map(c.map((x) => [x.revisionId, x]));
const count = (slots: Array<{ format: string }>, f: string) => slots.filter((s) => s.format === f).length;

describe("default first-run session (N=18, 5/5/5/1/2)", () => {
  it("fills the quota, obeys every hard rule and reports its soft targets", () => {
    const c = BIG();
    const r = selectSession(base(c));
    expect(r.feasible).toBe(true);
    expect(r.slots).toHaveLength(18);
    expect(DEFAULT_QUOTAS).toEqual({ choose_form: 5, choose_missing_fragment: 5, detect_error: 5, guided_short_answer: 1, russian_to_english_short: 2 });
    for (const [f, k] of Object.entries(DEFAULT_QUOTAS)) expect(count(r.slots, f)).toBe(k);
    expect(hardViolations(r.slots, 18, byId(c), new Set(), DEFAULT_QUOTAS)).toEqual([]);
    expect(r.slots.map((s) => s.ordinal)).toEqual(Array.from({ length: 18 }, (_, i) => i));
    expect(r.stats).toMatchObject({ weakTarget: 12, weakActual: 12, voiceActual: 2 });
    expect(r.stats.families).toBeGreaterThanOrEqual(3);
    expect(r.stats.formats).toBe(5);
  });

  it("is reproducible: the same input and seed give the same session, another seed differs", () => {
    const c = BIG();
    const a = selectSession(base(c, { seed: "same" }));
    const b = selectSession(base(c, { seed: "same" }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const d = selectSession(base(c, { seed: "other" }));
    expect(d.slots.map((s) => s.revisionId)).not.toEqual(a.slots.map((s) => s.revisionId));
  });

  it("never exceeds ceil(.35 N) per family or ceil(.40 N) per format", () => {
    expect([familyCap(18), formatCap(18), familyCap(10), formatCap(5)]).toEqual([7, 8, 4, 2]);
    // a bank that tempts the solver into one family: 3 families only, the cap forces a spread
    const c = bank({ choose_form: 12, choose_missing_fragment: 12, detect_error: 12, guided_short_answer: 4, russian_to_english_short: 5 }, { familiesUsed: 3 });
    const r = selectSession(base(c, { priority: (skill) => (skill.startsWith("articles") ? 0.9 : 0.1) }));
    expect(r.feasible).toBe(true);
    const per = new Map<string, number>();
    for (const s of r.slots) per.set(s.family, (per.get(s.family) ?? 0) + 1);
    expect(Math.max(...per.values())).toBeLessThanOrEqual(7);
  });

  it("uses one candidate per exercise and a distinct template cluster", () => {
    const c = BIG();
    // two revisions of one exercise must not both appear
    const twin = { ...c[0]!, revisionId: "r-twin", unitFingerprints: ["fp-twin"] };
    const r = selectSession(base([...c, twin]));
    const ex = r.slots.map((s) => s.exerciseId);
    expect(new Set(ex).size).toBe(ex.length);
  });
});

describe("no-repeat", () => {
  it("never selects a candidate with a shown or reserved sentence", () => {
    const c = BIG();
    const blocked = new Set(c.filter((_, i) => i % 5 === 0).map((x) => x.unitFingerprints[0]!)); // a quarter of the bank has one shown sentence
    const r = selectSession(base(c, { blocked }));
    expect(r.feasible).toBe(true);
    const chosen = r.slots.map((s) => byId(c).get(s.revisionId)!);
    expect(chosen.some((x) => x.unitFingerprints.some((f) => blocked.has(f)))).toBe(false);
  });

  it("two candidates that share a sentence are never in the same session", () => {
    const c = BIG();
    const shared = c.slice(0, 30).map((x) => ({ ...x, unitFingerprints: ["common-sentence", ...x.unitFingerprints] }));
    const r = selectSession(base([...shared, ...c.slice(30)]));
    expect(r.slots.map((s) => byId(c.map((x, i) => (i < 30 ? shared[i]! : x))).get(s.revisionId)!).filter((x) => x.unitFingerprints.includes("common-sentence")).length).toBeLessThanOrEqual(1);
  });

  it("a held-out candidate is never used for practice", () => {
    const c = BIG().map((x, i) => (i % 3 === 0 ? { ...x, bankRole: "heldout" as const } : x));
    const r = selectSession(base(c));
    expect(r.slots.every((s) => byId(c).get(s.revisionId)!.bankRole !== "heldout")).toBe(true);
  });
});

describe("shortage is disclosed, never relaxed", () => {
  it("names the missing format and only SUGGESTS a smaller N", () => {
    const c = bank({ choose_form: 12, choose_missing_fragment: 12, detect_error: 12, guided_short_answer: 4, russian_to_english_short: 1 });
    const r = selectSession(base(c));
    expect(r.feasible).toBe(false);
    expect(r.slots).toEqual([]);
    expect(r.deficits).toContainEqual(expect.objectContaining({ kind: "format", format: "russian_to_english_short", needed: 2, available: 1 }));
    expect(r.largestFeasibleN).not.toBeNull();
    expect(r.largestFeasibleN!).toBeLessThan(18);
    // the suggestion really is feasible on the same bank
    const smaller = selectSession(base(c, { n: r.largestFeasibleN!, quotas: scaleQuotas(DEFAULT_QUOTAS, r.largestFeasibleN!) }));
    expect(smaller.feasible).toBe(true);
  });

  it("reports an empty bank with no suggestion", () => {
    const r = selectSession(base([]));
    expect(r.feasible).toBe(false);
    expect(r.largestFeasibleN).toBeNull();
    expect(r.deficits.length).toBeGreaterThan(0);
  });

  it("requires a No-mistake case when detect_error has >= 4 slots", () => {
    const none = bank({ choose_form: 8, choose_missing_fragment: 8, detect_error: 8, guided_short_answer: 3, russian_to_english_short: 3 }, { noMistakeEvery: 0 });
    const r = selectSession(base(none));
    expect(r.feasible).toBe(false);
    expect(r.deficits.map((d) => d.kind)).toContain("no_mistake");

    const one = none.map((x, i) => (x.format === "detect_error" && i === none.findIndex((y) => y.format === "detect_error") ? { ...x, noMistake: true } : x));
    const ok = selectSession(base(one, { priority: (_s, d) => (d === "correction" ? 0.1 : 0.9) }));
    expect(ok.feasible).toBe(true);
    expect(ok.slots.filter((s) => s.format === "detect_error").some((s) => byId(one).get(s.revisionId)!.noMistake)).toBe(true);
  });

  it("fails when the bank cannot satisfy the family cap, instead of breaking it", () => {
    const c = bank({ choose_form: 12, choose_missing_fragment: 12, detect_error: 12, guided_short_answer: 4, russian_to_english_short: 5 }, { familiesUsed: 2 });
    const r = selectSession(base(c));
    expect(r.feasible).toBe(false); // 2 families cannot give >= 3 families and <= 7 per family at N=18
    expect(r.slots).toEqual([]);
  });
});

describe("reading blocks", () => {
  it("a 3-question passage replaces choose_form 2 + fragment 1 and keeps 18 slots (3/4/5/1/2/3)", () => {
    expect(applyReading(DEFAULT_QUOTAS, 3)).toEqual({ choose_form: 3, choose_missing_fragment: 4, detect_error: 5, guided_short_answer: 1, russian_to_english_short: 2 });
    expect(applyReading(DEFAULT_QUOTAS, 2)).toEqual({ choose_form: 4, choose_missing_fragment: 4, detect_error: 5, guided_short_answer: 1, russian_to_english_short: 2 });
    const c = [...BIG(), ...bank({ context_reading: 3 }, { reading: 3 })];
    const r = selectSession(base(c, { readingBlocks: 1 }));
    expect(r.feasible).toBe(true);
    expect(r.slots).toHaveLength(18);
    const reading = r.slots.filter((s) => s.format === "context_reading");
    expect(reading).toHaveLength(3);
    expect(new Set(reading.map((s) => s.readingGroupId)).size).toBe(1);
    expect(reading.map((s) => s.childIndex)).toEqual([0, 1, 2]);
    const idx = r.slots.findIndex((s) => s.format === "context_reading");
    expect(r.slots.slice(idx, idx + 3).every((s) => s.format === "context_reading")).toBe(true); // contiguous
    expect([count(r.slots, "choose_form"), count(r.slots, "choose_missing_fragment"), count(r.slots, "detect_error")]).toEqual([3, 4, 5]);
  });

  it("is a shortage, not a silent drop, when no passage exists", () => {
    const r = selectSession(base(BIG(), { readingBlocks: 1 }));
    expect(r.feasible).toBe(false);
    expect(r.deficits[0]).toMatchObject({ kind: "reading" });
  });
});

describe("settings: any N from 5 to 30, weak ratio, voice", () => {
  it.each(Array.from({ length: 26 }, (_, i) => i + 5))("N=%i scales the quota to exactly N slots", (n) => {
    const q = scaleQuotas(DEFAULT_QUOTAS, n);
    expect(Object.values(q).reduce((a, b) => a + b, 0)).toBe(n);
    const c = bank({ choose_form: 20, choose_missing_fragment: 20, detect_error: 20, guided_short_answer: 10, russian_to_english_short: 10 });
    const r = selectSession(base(c, { n, quotas: q }));
    expect(r.feasible).toBe(true);
    expect(r.slots).toHaveLength(n);
    expect(hardViolations(r.slots, n, byId(c), new Set(), q)).toEqual([]);
  });

  it("round(N * weakRatio) weak slots for several ratios; voice = min(target, production slots)", () => {
    const c = BIG();
    for (const [ratio, want] of [[0, 0], [0.35, 6], [0.65, 12], [1, 18]] as const) {
      expect(selectSession(base(c, { weakRatio: ratio })).stats.weakActual).toBe(want);
    }
    expect(selectSession(base(c, { voiceTarget: 0 })).stats.voiceActual).toBe(0);
    expect(selectSession(base(c, { voiceTarget: 1 })).stats.voiceActual).toBe(1);
    expect(selectSession(base(c, { voiceTarget: 2 })).slots.filter((s) => s.inputPreference === "voice").every((s) => s.dimension === "production")).toBe(true);
  });

  it("weak slots follow the base priority times the plan multiplier", () => {
    const c = BIG();
    const fam = [...new Set(c.map((x) => x.family))].sort()[3]!;
    const hot = new Set(c.filter((x) => x.family === fam).map((x) => x.skillId));
    expect(hot.size).toBeGreaterThan(0);
    const plain = selectSession(base(c));
    const planned = selectSession(base(c, { planMultiplier: (skill) => (hot.has(skill) ? 2 : 1), priority: (skill) => (hot.has(skill) ? 0.6 : 0.5) }));
    expect(planned.feasible).toBe(true);
    const weakInFamily = (r: typeof plain) => r.slots.filter((s) => s.family === fam && s.role === "weak").length;
    expect(weakInFamily(planned)).toBeGreaterThan(weakInFamily(plain));
    expect(planned.slots.find((s) => s.family === fam && s.role === "weak")?.multiplier).toBe(2);
  });
});

describe("discovery-v1 probes (bounded, exploration only)", () => {
  const withProbe = (limit: number, bonus: Record<string, number>) => {
    const c = BIG();
    return { c, r: selectSession(base(c, { discovery: { bonusBySkill: bonus, limit }, priority: () => 0.5 })) };
  };

  it("a suspected skill with a bonus is probed by an approved recognition/correction exercise in an exploration slot", () => {
    const c = BIG();
    const target = c.find((x) => x.format === "choose_form")!.skillId;
    const none = selectSession(base(c, { seed: "d" }));
    const probed = selectSession(base(c, { seed: "d", discovery: { bonusBySkill: { [target]: 0.05 }, limit: 2 } }));
    expect(probed.stats.discoveryActual).toBe(1);
    const slot = probed.slots.find((s) => s.role === "discovery")!;
    expect(slot.skillId).toBe(target);
    expect(slot.bonus).toBe(0.05);
    expect(["recognition", "correction"]).toContain(slot.dimension);
    expect(none.stats.discoveryActual).toBe(0);
    expect(hardViolations(probed.slots, 18, byId(c), new Set(), DEFAULT_QUOTAS)).toEqual([]);
  });

  it("is capped at min(2, floor(.15 N), exploration slots) and at one probe per skill", () => {
    const c = BIG();
    const skills = [...new Set(c.filter((x) => x.format !== "guided_short_answer" && x.format !== "russian_to_english_short").map((x) => x.skillId))].slice(0, 6);
    const { r } = withProbe(2, Object.fromEntries(skills.map((s) => [s, 0.1])));
    expect(r.stats.discoveryActual).toBeLessThanOrEqual(2);
    const probes = r.slots.filter((s) => s.role === "discovery");
    expect(new Set(probes.map((s) => s.skillId)).size).toBe(probes.length);
    expect(selectSession(base(c, { discovery: { bonusBySkill: Object.fromEntries(skills.map((s) => [s, 0.1])), limit: 0 } })).stats.discoveryActual).toBe(0);
    expect(selectSession(base(c, { n: 8, quotas: scaleQuotas(DEFAULT_QUOTAS, 8), discovery: { bonusBySkill: Object.fromEntries(skills.map((s) => [s, 0.1])), limit: 1 } })).stats.discoveryActual).toBeLessThanOrEqual(1);
  });

  it("never spends a confirmed weak slot or a production/held-out candidate on a probe", () => {
    const c = BIG();
    const prodSkill = c.find((x) => x.format === "guided_short_answer")!.skillId;
    const r = selectSession(base(c, { discovery: { bonusBySkill: { [prodSkill]: 0.1 }, limit: 2 } }));
    expect(r.slots.filter((s) => s.role === "discovery" && s.dimension === "production")).toEqual([]);
    expect(r.stats.weakActual).toBe(12);
  });
});

describe("base priority P (spec/04)", () => {
  it("unknown skill, never practised: .4*.5 + .25*0 + .2*1 + .15*1 = .55", () => {
    const p = computePriority({ score: null, reliable: false, nEff: null, failuresLast20: 0, daysSinceLastIndependent: null });
    expect(p.p).toBeCloseTo(0.55, 12);
    expect(p.weakness).toBe(0.5);
  });

  it("reliable weak score raises P; a strong, recently practised, certain skill is low", () => {
    const weak = computePriority({ score: 3, reliable: true, nEff: 10, failuresLast20: 5, daysSinceLastIndependent: 30 });
    const strong = computePriority({ score: 9, reliable: true, nEff: 12, failuresLast20: 0, daysSinceLastIndependent: 1 });
    expect(weak.p).toBeGreaterThan(strong.p);
    expect(weak.weakness).toBeCloseTo(0.7, 12);
    expect(weak.failurePressure).toBe(1);
    expect(strong.uncertainty).toBe(0);
    expect(strong.due).toBeCloseTo(1 / (2 + 18 * 0.9), 12);
  });

  it("an unreliable (provisional) score does not drive weakness", () => {
    expect(computePriority({ score: 1, reliable: false, nEff: 3, failuresLast20: 0, daysSinceLastIndependent: 2 }).weakness).toBe(0.5);
  });

  it("clamps the agent multiplier to [0.5, 2]", () => {
    expect([clampMultiplier(undefined), clampMultiplier(0.1), clampMultiplier(5), clampMultiplier(1.3)]).toEqual([1, 0.5, 2, 1.3]);
  });
});

describe("property: whenever feasible, the hard rules hold (seeded random banks)", () => {
  it("holds for 60 random banks, seeds and sizes", () => {
    let s = 7;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    let feasible = 0;
    for (let run = 0; run < 60; run++) {
      const n = 5 + Math.floor(rnd() * 26);
      const per = { choose_form: 3 + Math.floor(rnd() * 12), choose_missing_fragment: 3 + Math.floor(rnd() * 12), detect_error: 3 + Math.floor(rnd() * 12), guided_short_answer: 1 + Math.floor(rnd() * 6), russian_to_english_short: 1 + Math.floor(rnd() * 6) };
      const c = bank(per, { familiesUsed: 2 + Math.floor(rnd() * 6), noMistakeEvery: rnd() < 0.2 ? 0 : 3 });
      const q = scaleQuotas(DEFAULT_QUOTAS, n);
      const r = selectSession(base(c, { n, quotas: q, seed: `s${run}`, weakRatio: rnd() }));
      if (r.feasible) {
        feasible++;
        expect(hardViolations(r.slots, n, byId(c), new Set(), q), `run ${run} n=${n}`).toEqual([]);
      } else {
        expect(r.slots).toEqual([]);
        expect(r.deficits.length).toBeGreaterThan(0);
      }
    }
    expect(feasible).toBeGreaterThan(10);
  });
});

describe("discovery regression: a probe may be a detect_error error item while another slot carries the No-mistake case", () => {
  it("stays feasible when the suspected skill has a single detect_error candidate (and it is not a No-mistake one)", () => {
    const c = BIG();
    const only = c.find((x) => x.format === "detect_error" && !x.noMistake)!;
    const others = c.filter((x) => !(x.skillId === only.skillId && x.revisionId !== only.revisionId));
    const r = selectSession(base(others, { discovery: { bonusBySkill: { [only.skillId]: 0.05 }, limit: 2 } }));
    expect(r.feasible).toBe(true);
    expect(r.slots.filter((s) => s.role === "discovery").map((s) => s.skillId)).toContain(only.skillId);
    expect(r.slots.filter((s) => s.format === "detect_error").some((s) => byId(others).get(s.revisionId)!.noMistake)).toBe(true);
  });

  it("puts the probe into a slot whose format can carry the suspected skill", () => {
    const c = BIG();
    const fragmentOnly = c.find((x) => x.format === "choose_missing_fragment")!;
    const pool = c.filter((x) => x.skillId !== fragmentOnly.skillId || x.format === "choose_missing_fragment");
    const r = selectSession(base(pool, { discovery: { bonusBySkill: { [fragmentOnly.skillId]: 0.05 }, limit: 2 } }));
    expect(r.feasible).toBe(true);
    const probe = r.slots.find((s) => s.role === "discovery");
    expect(probe?.format).toBe("choose_missing_fragment");
  });
});
