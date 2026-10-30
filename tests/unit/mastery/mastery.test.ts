import { describe, expect, it } from "vitest";
import {
  MASTERY_V1,
  canonicalJson,
  computeComponents,
  displayScore,
  markDelayedProbes,
  summarizeSkill,
  wilson95,
  type EvidenceOpportunity,
} from "../../../packages/learning/src/index.js";

const EPS = 1e-9;
const DAY = 86_400_000;
const T0 = Date.parse("2026-10-01T02:00:00Z");
const at = (daysAgo: number) => new Date(T0 - daysAgo * DAY).toISOString();
let seq = 0;
const opp = (o: Partial<EvidenceOpportunity> & { ageDays?: number; day?: string } = {}): EvidenceOpportunity => {
  const age = o.ageDays ?? 0;
  return {
    id: o.id ?? `o${String(++seq).padStart(4, "0")}`,
    at: o.at ?? at(age),
    localDate: o.localDate ?? o.day ?? at(age).slice(0, 10),
    success: o.success ?? true,
    heldout: o.heldout ?? false,
    delayedProbe: o.delayedProbe ?? false,
  };
};
const many = (n: number, make: (i: number) => Partial<EvidenceOpportunity> & { ageDays?: number }) => Array.from({ length: n }, (_, i) => opp(make(i)));
const AS_OF = at(0);

describe("spec/04 worked examples (all ages 0, weight 1)", () => {
  it("no attempts: S = null, unknown, never 0", () => {
    const c = computeComponents([], AS_OF);
    expect(c).toMatchObject({ score: null, a: null, h: null, n: 0, status: "unknown", label: "unknown", nEff: null });
  });

  it("one correct answer: A = 2/3, H = A, S = 6.6667, provisional", () => {
    const c = computeComponents([opp()], AS_OF);
    expect(c.a).toBeCloseTo(2 / 3, 12);
    expect(c.h).toBe(c.a);
    expect(c.hSource).toBe("no_independent_check");
    expect(Math.abs((c.score as number) - 20 / 3)).toBeLessThan(EPS);
    expect(displayScore(c.score)).toBe(6.7);
    expect(c).toMatchObject({ n: 1, status: "insufficient", label: "insufficient" });
  });

  const row3 = () => [
    ...many(5, () => ({ success: true })),
    ...many(1, () => ({ success: false })),
    ...many(2, () => ({ success: false })), // IDK = failure
    ...many(3, () => ({ success: true, heldout: true })),
    ...many(1, () => ({ success: false, heldout: true })),
  ];

  it("8 correct, 2 incorrect, 2 IDK with held-out 3/4: A = 9/14, H = 4/6, S = 6.5", () => {
    const c = computeComponents(row3(), AS_OF);
    expect(Math.abs((c.a as number) - 9 / 14)).toBeLessThan(EPS);
    expect(Math.abs((c.h as number) - 4 / 6)).toBeLessThan(EPS);
    expect(Math.abs((c.score as number) - 6.5)).toBeLessThan(EPS);
    expect(c).toMatchObject({ n: 12, heldoutN: 4, successes: 8, hSource: "independent_check", status: "insufficient" }); // one day only
  });

  it("12 correct with held-out 4/4: A = 13/14, H = 5/6, S = 9.0, provisional on a single day", () => {
    const c = computeComponents([...many(8, () => ({})), ...many(4, () => ({ heldout: true }))], AS_OF);
    expect(Math.abs((c.a as number) - 13 / 14)).toBeLessThan(EPS);
    expect(Math.abs((c.h as number) - 5 / 6)).toBeLessThan(EPS);
    expect(Math.abs((c.score as number) - 9)).toBeLessThan(EPS);
    expect(c.status).toBe("insufficient");
  });

  it("a confirmed wrong->correct re-assessment moves A to 10/14 and S to 7.0; H unchanged", () => {
    const fixed = row3();
    const firstWrong = fixed.findIndex((o) => !o.success && !o.heldout);
    fixed[firstWrong] = { ...fixed[firstWrong]!, success: true };
    const c = computeComponents(fixed, AS_OF);
    expect(Math.abs((c.a as number) - 10 / 14)).toBeLessThan(EPS);
    expect(Math.abs((c.h as number) - 4 / 6)).toBeLessThan(EPS);
    expect(Math.abs((c.score as number) - 7)).toBeLessThan(EPS);
  });

  it("R=9, C=7, P=5 with stable evidence: summary 6.4; production stays separate", () => {
    const s = (score: number) => ({ score, status: "stable" as const });
    const sum = summarizeSkill({ recognition: s(9), correction: s(7), production: s(5) });
    expect(Math.abs((sum.score as number) - 6.4)).toBeLessThan(EPS);
    expect(sum.reason).toBe("ok");
  });

  it("summary is null while any dimension lacks stable evidence (recognition never stands in for production)", () => {
    const stable = { score: 9, status: "stable" as const };
    expect(summarizeSkill({ recognition: stable, correction: stable })).toMatchObject({ score: null, reason: "insufficient_dimensions", missing: ["production"] });
    expect(summarizeSkill({ recognition: stable, correction: stable, production: { score: 9, status: "developing" } }).missing).toEqual(["production"]);
    expect(summarizeSkill({}).score).toBeNull();
  });
});

describe("worked example with real day distribution", () => {
  // 12 correct, 4 each at ages 0/7/14 days; held-out 4 = 2 at age 0 + 2 at age 7
  const opps = () => [
    ...many(2, () => ({ ageDays: 0, heldout: true })),
    ...many(2, () => ({ ageDays: 0 })),
    ...many(2, () => ({ ageDays: 7, heldout: true })),
    ...many(2, () => ({ ageDays: 7 })),
    ...many(4, () => ({ ageDays: 14 })),
  ];

  it("reproduces A, H, S and N_eff from the spec to 1e-9", () => {
    const c = computeComponents(opps(), AS_OF);
    expect(Math.abs((c.a as number) - 0.9236170878616091)).toBeLessThan(EPS);
    expect(Math.abs((c.h as number) - 0.8289028404601023)).toBeLessThan(EPS);
    expect(Math.abs((c.score as number) - 8.95202813641157)).toBeLessThan(EPS);
    expect(Math.abs((c.nEff as number) - 11.947995755992096)).toBeLessThan(EPS);
    expect(displayScore(c.score)).toBe(9);
    expect(c).toMatchObject({ n: 12, days: 3, heldoutN: 4, heldoutDays: 2, status: "stable", label: "stable" });
  });

  it("40 days without new evidence: numeric S unchanged, label turns stale, nothing is invented", () => {
    const list = opps();
    const fresh = computeComponents(list, AS_OF);
    const later = computeComponents(list, new Date(T0 + 40 * DAY).toISOString());
    expect(later.score).toBe(fresh.score);
    expect(later.a).toBe(fresh.a);
    expect(later.status).toBe("stale");
    expect(later.tE).toBe(fresh.tE);
  });
});

describe("window, time travel and determinism", () => {
  it("uses only the last 40 eligible opportunities", () => {
    const old = many(20, (i) => ({ ageDays: 200 - i, success: false }));
    const recent = many(40, (i) => ({ ageDays: 39 - i, success: true }));
    const c = computeComponents([...old, ...recent], AS_OF);
    expect(c.n).toBe(40);
    expect(c.selectedIds).toEqual(recent.map((o) => o.id));
    expect(c.successes).toBe(40);
  });

  it("ignores evidence after as_of", () => {
    const past = opp({ ageDays: 5 });
    const future = opp({ ageDays: -3 });
    const c = computeComponents([past, future], AS_OF);
    expect(c.selectedIds).toEqual([past.id]);
  });

  it("older evidence weighs less: the same failure costs more when recent", () => {
    // identical history shape (6 successes, then one failure); only the failure's age relative to the successes differs
    const successes = many(6, () => ({ ageDays: 10 }));
    const failureOld = computeComponents([...successes, opp({ ageDays: 10, success: false })], AS_OF);
    const failureNew = computeComponents([...successes, opp({ ageDays: 0, success: false })], AS_OF);
    expect(failureNew.score as number).toBeLessThan(failureOld.score as number);
  });

  it("is independent of input order and bit-identical on replay", () => {
    const all = [...many(15, (i) => ({ ageDays: i, success: i % 3 !== 0, heldout: i % 4 === 0 })), ...many(5, () => ({ ageDays: 3, success: true }))];
    const a = computeComponents(all, AS_OF);
    const b = computeComponents([...all].reverse(), AS_OF);
    expect(canonicalJson(b)).toBe(canonicalJson(a));
    expect(Object.is(a.score, b.score)).toBe(true);
  });

  it("breaks timestamp ties by id", () => {
    const x = { ...opp({ id: "b", success: true }), at: at(1) };
    const y = { ...opp({ id: "a", success: false }), at: at(1) };
    expect(computeComponents([x, y], AS_OF).selectedIds).toEqual(["a", "b"]);
  });

  it("score stays inside (0, 10) for random histories (seeded)", () => {
    let s = 12345;
    const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let run = 0; run < 200; run++) {
      const n = Math.floor(rnd() * 60);
      const list = many(n, () => ({ ageDays: Math.floor(rnd() * 400), success: rnd() < 0.5, heldout: rnd() < 0.3, delayedProbe: rnd() < 0.2 }));
      const c = computeComponents(list, AS_OF);
      if (n === 0) expect(c.score).toBeNull();
      else {
        expect(c.score as number).toBeGreaterThan(0);
        expect(c.score as number).toBeLessThan(10);
        expect(c.nEff as number).toBeGreaterThan(0);
        expect(c.nEff as number).toBeLessThanOrEqual(c.n + EPS);
      }
    }
  });
});

describe("evidence status thresholds (engineering heuristics, spec/04)", () => {
  const spread = (n: number, daysSpan: number, extra: (i: number) => Partial<EvidenceOpportunity> = () => ({})) =>
    many(n, (i) => ({ ageDays: i % daysSpan, ...extra(i) }));

  it("n < 12 -> insufficient", () => expect(computeComponents(spread(11, 5), AS_OF).status).toBe("insufficient"));
  it("fewer than 3 distinct local days -> insufficient", () => expect(computeComponents(spread(20, 2), AS_OF).status).toBe("insufficient"));
  it("N_eff < 8 -> insufficient even with n >= 12 and 3 days", () => {
    const list = [...many(12, () => ({ ageDays: 400 })), ...many(3, (i) => ({ ageDays: i }))];
    const c = computeComponents(list, AS_OF);
    expect(c.n).toBe(15);
    expect(c.nEff as number).toBeLessThan(8);
    expect(c.status).toBe("insufficient");
  });
  it("enough evidence but held-out < 4 or on one day -> developing", () => {
    expect(computeComponents(spread(14, 5, (i) => ({ heldout: i < 3 })), AS_OF).status).toBe("developing");
    const oneDay = many(14, (i) => ({ ageDays: i < 4 ? 0 : (i % 4) + 1, heldout: i < 4 }));
    expect(computeComponents(oneDay, AS_OF)).toMatchObject({ heldoutN: 4, heldoutDays: 1, status: "developing" });
  });
  it("stable needs held-out >= 4 on >= 2 days and last evidence <= 30 days old", () => {
    const list = spread(14, 5, (i) => ({ heldout: i < 5 }));
    expect(computeComponents(list, AS_OF).status).toBe("stable");
    expect(computeComponents(list, new Date(T0 + 30 * DAY).toISOString()).status).toBe("stable");
    expect(computeComponents(list, new Date(T0 + 31 * DAY).toISOString()).status).toBe("stale");
  });
  it("labels: weak < 6 <= improving < 8 <= stable; maintenance needs 2 delayed successes on different days", () => {
    const stableList = (success: (i: number) => boolean, extra: (i: number) => Partial<EvidenceOpportunity> = () => ({})) =>
      spread(16, 5, (i) => ({ heldout: i < 6, success: success(i), ...extra(i) }));
    expect(computeComponents(stableList((i) => i % 2 === 0), AS_OF)).toMatchObject({ status: "stable", label: "weak" });
    expect(computeComponents(stableList((i) => i % 4 !== 0), AS_OF).label).toBe("improving");
    expect(computeComponents(stableList(() => true), AS_OF).label).toBe("stable");
    // i = 1 and i = 2 sit on different local days (ageDays = i % 5)
    expect(computeComponents(stableList(() => true, (i) => ({ delayedProbe: i === 1 })), AS_OF).label).toBe("stable");
    expect(computeComponents(stableList(() => true, (i) => ({ delayedProbe: i === 1 || i === 2 })), AS_OF).label).toBe("maintenance");
    // i = 0 and i = 5 share a local day
    expect(computeComponents(stableList(() => true, (i) => ({ delayedProbe: i === 0 || i === 5 })), AS_OF).label).toBe("stable");
  });
});

describe("delayed probes (>= 7 days after the last earlier practice)", () => {
  it("marks only opportunities that follow a >= 7 day gap; the first-ever practice is not a probe", () => {
    const list = [opp({ id: "a", ageDays: 20 }), opp({ id: "b", ageDays: 14 }), opp({ id: "c", ageDays: 5 }), opp({ id: "d", ageDays: 4 })];
    const marked = markDelayedProbes(list, list.map((o) => o.at), MASTERY_V1);
    expect(marked.map((m) => [m.id, m.delayedProbe])).toEqual([["a", false], ["b", false], ["c", true], ["d", false]]);
  });

  it("assisted practice (retries, hints) in the gap resets the clock", () => {
    const list = [opp({ id: "a", ageDays: 20 }), opp({ id: "b", ageDays: 5 })];
    const withRetry = markDelayedProbes(list, [list[0]!.at, at(9), list[1]!.at]);
    expect(withRetry.find((m) => m.id === "b")!.delayedProbe).toBe(false);
  });
});

describe("Wilson interval and display", () => {
  it("matches the closed form and stays inside [0,1]", () => {
    const w = wilson95(3, 4, 1.96)!;
    expect(w.low).toBeCloseTo(0.3006, 3);
    expect(w.high).toBeCloseTo(0.9544, 3);
    expect(wilson95(0, 5, 1.96)!.low).toBe(0);
    expect(wilson95(5, 5, 1.96)!.high).toBeLessThanOrEqual(1);
    expect(wilson95(0, 0, 1.96)).toBeNull();
  });
  it("rounds only for display", () => {
    expect(displayScore(8.95202813641157)).toBe(9);
    expect(displayScore(6.666666666666667)).toBe(6.7);
    expect(displayScore(null)).toBeNull();
  });
  it("canonical JSON sorts keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe('{"a":[2,{"d":1}],"b":1}');
  });
});
