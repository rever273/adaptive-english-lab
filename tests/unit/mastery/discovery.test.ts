import { describe, expect, it } from "vitest";
import {
  DISCOVERY_V1,
  computeDiscovery,
  discoveryProbeLimit,
  rankProbeCandidates,
  type DiscoveryConfig,
  type FindingSignal,
} from "../../../packages/learning/src/index.js";

const ASOF = "2026-10-28T00:00:00.000Z";
const MODEL = "qwen3:14b@sha256:abc";
const CFG: DiscoveryConfig = { ...DISCOVERY_V1, qualifiedModels: [{ key: MODEL, qualificationId: "qual-1" }] };
let n = 0;
const f = (o: Partial<FindingSignal> = {}): FindingSignal => ({
  findingId: `f${String(++n).padStart(3, "0")}`,
  attemptId: `a${n}`,
  skillId: "articles.definite",
  contextId: `ctx${n}`,
  confidence: 0.9,
  findingType: "grammar",
  effectiveVerdict: "tentative",
  skillKnown: true,
  modelKey: MODEL,
  at: "2026-10-20T00:00:00.000Z",
  firstAttempt: true,
  latestAnalysis: true,
  ...o,
});
const bonus = (list: FindingSignal[], probes: Record<string, string> = {}, cfg = CFG) => computeDiscovery(list, probes, ASOF, cfg).find((r) => r.skillId === "articles.definite");

describe("discovery-v1 bonus", () => {
  it("one recommendation, even high-confidence, gives 0", () => expect(bonus([f()])).toMatchObject({ k: 1, bonus: 0 }));

  it("two qualified tentative findings from different attempts and contexts give min(.10, .025k) = .05", () => {
    const r = bonus([f(), f()])!;
    expect(r).toMatchObject({ k: 2, contexts: 2 });
    expect(r.bonus).toBeCloseTo(0.05, 12);
    expect(r.qualificationIds).toEqual(["qual-1"]);
    expect(r.sourceFindingIds).toHaveLength(2);
  });

  it("is capped at .10", () => expect(bonus(Array.from({ length: 9 }, () => f()))!.bonus).toBeCloseTo(0.1, 12));

  it.each([
    ["same context twice", () => [f({ contextId: "same" }), f({ contextId: "same" })]],
    ["same attempt twice (re-delivery / two findings)", () => [f({ attemptId: "x" }), f({ attemptId: "x" })]],
    ["low confidence", () => [f(), f({ confidence: 0.79 })]],
    ["missing confidence", () => [f(), f({ confidence: null })]],
    ["style finding", () => [f(), f({ findingType: "style" })]],
    ["ambiguity finding", () => [f(), f({ findingType: "ambiguity" })]],
    ["rejected by review", () => [f(), f({ effectiveVerdict: "rejected" })]],
    ["disputed", () => [f(), f({ effectiveVerdict: "disputed" })]],
    ["uncertain", () => [f(), f({ effectiveVerdict: "uncertain" })]],
    ["confirmed (no longer a hypothesis)", () => [f(), f({ effectiveVerdict: "confirmed" })]],
    ["unqualified model", () => [f(), f({ modelKey: "qwen3:8b@sha256:other" })]],
    ["no model", () => [f(), f({ modelKey: null })]],
    ["unknown skill", () => [f(), f({ skillKnown: false })]],
    ["not a first attempt", () => [f(), f({ firstAttempt: false })]],
    ["superseded analysis", () => [f(), f({ latestAnalysis: false })]],
    ["outside the 30-day window", () => [f(), f({ at: "2026-09-20T00:00:00.000Z" })]],
    ["after as_of", () => [f(), f({ at: "2026-10-29T00:00:00.000Z" })]],
  ])("%s -> bonus 0", (_n, make) => {
    const r = bonus(make());
    expect(r?.bonus ?? 0).toBe(0);
  });

  it("a rejected or disputed finding drops k from 2 to 1 and the bonus to 0", () => {
    expect(bonus([f(), f()])!.bonus).toBeGreaterThan(0);
    expect(bonus([f(), f({ effectiveVerdict: "rejected" })])!.bonus).toBe(0);
  });

  it("a confirmed probe after the findings retires them; only newer findings can start a new hypothesis", () => {
    const old = [f({ at: "2026-10-10T00:00:00.000Z" }), f({ at: "2026-10-11T00:00:00.000Z" })];
    const probe = { "articles.definite": "2026-10-15T00:00:00.000Z" };
    expect(bonus(old, probe)?.bonus ?? 0).toBe(0);
    const newer = [f({ at: "2026-10-16T00:00:00.000Z" }), f({ at: "2026-10-17T00:00:00.000Z" })];
    expect(bonus([...old, ...newer], probe)!).toMatchObject({ k: 2, bonus: 0.05 });
    expect(bonus([...old, newer[0]!], probe)?.bonus ?? 0).toBe(0); // one new finding is not enough
  });

  it("is disabled while no model is qualified (before the TASK_009 gate)", () => {
    expect(computeDiscovery([f(), f()], {}, ASOF, DISCOVERY_V1)).toEqual([]);
  });

  it("is deterministic and order-independent", () => {
    const list = [f(), f(), f(), f({ skillId: "countability.mass_nouns" }), f({ skillId: "countability.mass_nouns" })];
    expect(JSON.stringify(computeDiscovery([...list].reverse(), {}, ASOF, CFG))).toBe(JSON.stringify(computeDiscovery(list, {}, ASOF, CFG)));
  });
});

describe("probe ranking and limits", () => {
  const base = (skillId: string, o: Partial<Parameters<typeof rankProbeCandidates>[0][number]> = {}) => ({
    skillId,
    basePriority: 0.5,
    planMultiplier: 1,
    dimension: "recognition" as const,
    bankRole: "practice" as const,
    ...o,
  });

  it("with equal base priority the skill with a bonus is chosen first; without it the order is the old one", () => {
    const cands = [base("articles.definite"), base("countability.mass_nouns")];
    expect(rankProbeCandidates(cands, {}).map((r) => r.skillId)).toEqual(["articles.definite", "countability.mass_nouns"]);
    const ranked = rankProbeCandidates([...cands].reverse(), { "countability.mass_nouns": 0.05 });
    expect(ranked.map((r) => r.skillId)).toEqual(["countability.mass_nouns", "articles.definite"]);
    expect(ranked[0]).toMatchObject({ bonus: 0.05, pSelect: 0.55 });
  });

  it("the bonus is not scaled by the agent multiplier", () => {
    const [r] = rankProbeCandidates([base("a", { planMultiplier: 2 })], { a: 0.1 });
    expect(r!.pSelect).toBeCloseTo(1.1, 12);
  });

  it("never applies to production or held-out candidates", () => {
    const r = rankProbeCandidates([base("a", { dimension: "production" }), base("b", { bankRole: "heldout" }), base("c", { dimension: "correction", bankRole: "diagnostic" })], { a: 0.1, b: 0.1, c: 0.1 });
    expect(Object.fromEntries(r.map((x) => [x.skillId, x.bonus]))).toEqual({ a: 0, b: 0, c: 0.1 });
  });

  it("limits discovery probes to min(2, floor(.15 N), exploration slots)", () => {
    expect(discoveryProbeLimit(18, 6)).toBe(2);
    expect(discoveryProbeLimit(18, 1)).toBe(1);
    expect(discoveryProbeLimit(5, 4)).toBe(0);
    expect(discoveryProbeLimit(30, 9)).toBe(2);
    expect(discoveryProbeLimit(10, 0)).toBe(0);
  });
});
