import { describe, expect, it } from "vitest";
import { familyOf, planThemedSession, type ThemedCandidate } from "../../../apps/server/src/domain/grammarCloze/select.js";
import { validateAudit } from "../../../apps/server/src/domain/grammarCloze/audit.js";

/** rules -> [family, count] */
function bank(spec: Record<string, [string, number]>, checked: (rule: string, i: number) => boolean = () => false): ThemedCandidate[] {
  return Object.entries(spec).flatMap(([rule, [family, n]]) => Array.from({ length: n }, (_, i) => ({ itemId: `${rule}#${String(i).padStart(3, "0")}`, ruleKey: rule, family, checked: checked(rule, i) })));
}
const SPEC: Record<string, [string, number]> = {
  "tenses.past_simple": ["past", 30],
  "tenses.present_perfect": ["past", 30],
  "tenses.past_continuous": ["past", 30],
  "tenses.present_simple": ["present", 30],
  "tenses.present_continuous": ["present", 30],
  "articles.definite": ["determiners", 30],
  "articles.indefinite": ["determiners", 30],
  "modals.advice": ["modals", 30],
  "passive.past": ["passive", 30],
  "comparisons.comparatives": ["comparisons", 30],
};
const plan = (o: Partial<Parameters<typeof planThemedSession>[0]> = {}) =>
  planThemedSession({ available: bank(SPEC), history: new Map(), recentFocus: [], mistakes: new Map(), size: 15, seed: 7, ...o });

describe("themed sessions (cloze-select-v2)", () => {
  it("maps topics to families", () => {
    expect(familyOf("present_perfect")).toBe("past");
    expect(familyOf("quantifiers")).toBe("determiners");
    expect(familyOf("something_new")).toBe("other");
  });

  it("gives ~40% to one focus family spread over its rules, and mixes the rest from other families", () => {
    const r = plan();
    expect(r.items).toHaveLength(15);
    const focus = r.items.filter((c) => c.family === r.plan.focus);
    expect(focus.length).toBeGreaterThanOrEqual(6);
    expect(new Set(focus.map((c) => c.ruleKey)).size).toBeGreaterThanOrEqual(2);
    expect(new Set(r.items.map((c) => c.family)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(r.items.map((c) => c.itemId)).size).toBe(15);
    for (let i = 2; i < r.items.length; i++) expect(r.items[i]!.ruleKey === r.items[i - 1]!.ruleKey && r.items[i]!.ruleKey === r.items[i - 2]!.ruleKey).toBe(false);
  });

  it("rotates the focus: a family focused recently waits", () => {
    const all = ["past", "present", "determiners", "modals", "passive"];
    const r = plan({ recentFocus: ["past", "present", "determiners", "modals", "passive"] });
    expect(all).not.toContain(r.plan.focus); // comparisons was never focused
    const r2 = plan({ recentFocus: ["past", "present", "determiners", "modals", "passive", "comparisons"] });
    expect(r2.plan.focus).toBe("comparisons"); // the oldest focus comes back first
  });

  it("brings back rules with recent mistakes as review, with new sentences", () => {
    const r = plan({ recentFocus: ["comparisons"], mistakes: new Map([["modals.advice", 3]]) });
    if (r.plan.focus !== "modals") {
      expect(r.plan.review).toContain("modals.advice");
      expect(r.items.filter((c) => c.ruleKey === "modals.advice").length).toBeGreaterThanOrEqual(2);
    }
    // the previous focus family is revisited too
    expect(r.items.some((c) => c.family === "comparisons")).toBe(true);
  });

  it("prefers sentences that passed the background check", () => {
    const r = planThemedSession({ available: bank(SPEC, (_rule, i) => i < 5), history: new Map(), recentFocus: [], mistakes: new Map(), size: 15, seed: 3 });
    expect(r.items.every((c) => c.checked)).toBe(true);
  });

  it("is deterministic for a seed and copes with a tiny bank", () => {
    expect(plan().items.map((c) => c.itemId)).toEqual(plan().items.map((c) => c.itemId));
    const tiny = planThemedSession({ available: bank({ a: ["past", 2], b: ["modals", 1] }), history: new Map(), recentFocus: [], mistakes: new Map(), size: 15, seed: 1 });
    expect(tiny.items).toHaveLength(3);
  });
});

describe("validateAudit", () => {
  const item = { gapped: "Li Ming ___ in Beijing since 2010.", solution: "has lived", distractors: ["lived", "lives"] };
  const out = (o: Record<string, unknown>) => JSON.stringify({ verdict: "key_ok", other_correct: [], reason_ru: "since 2010 — действие длится до сих пор → Present Perfect", cues: ["since 2010"], names: ["Li Ming", "Beijing"], ...o });

  it("keeps a clean opinion", () => {
    expect(validateAudit(out({}), item)).toEqual({ verdict: "key_ok", other_correct: [], reason_ru: "since 2010 — действие длится до сих пор → Present Perfect", cues: ["since 2010"], names: ["Li Ming", "Beijing"] });
  });

  it("drops cues and names that are not in the sentence or are options, and refuses a non-Russian reason or bad JSON", () => {
    const v = validateAudit(out({ cues: ["since 2010", "already", "lived", "___"], names: ["Shanghai", "Li Ming"] }), item)!;
    expect(v.cues).toEqual(["since 2010"]);
    expect(v.names).toEqual(["Li Ming"]);
    expect(validateAudit(out({ reason_ru: "Present Perfect" }), item)).toBeNull();
    expect(validateAudit("nope", item)).toBeNull();
    expect(validateAudit(out({ verdict: "maybe" }), item)).toBeNull();
  });

  it("reads key_ok with another fitting option as several_correct, and keeps only real options", () => {
    const v = validateAudit(out({ other_correct: ["Lives ", "went"] }), item)!;
    expect(v.verdict).toBe("several_correct");
    expect(v.other_correct).toEqual(["lives"]);
  });
});
