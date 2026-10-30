import { wilson95 } from "@english-lab/learning";

/** Benchmark-v1 scoring (spec/BENCHMARK.md). Pure: it only counts what the stored model outputs say. */

export type Expected = "correct" | "grammar_error" | "ambiguous";
export type Predicted = "accept" | "flag" | "abstain" | "invalid";

export interface BenchCase {
  id: string;
  group: string;
  topic: string;
  text: string;
  expected: Expected;
  skill_id: string;
  split: "development" | "heldout";
}

export interface CaseResult {
  caseId: string;
  model: string;
  /** 0-based repeat index of the full pass */
  run: number;
  phase: "warm" | "cold";
  predicted: Predicted;
  /** skill ids the model attributed findings to (analysis only) */
  skills: string[];
  validBeforeRepair: boolean;
  validAfterRepair: boolean;
  latencyMs: number;
  loadMs: number | null;
  evalTokens: number | null;
  evalMs: number | null;
  /** the model's own words (judgement) for the audit trail */
  rawJudgement: string;
  reviewProbability?: number;
  schemaValidBeforeRepair?: boolean;
  schemaValidAfterRepair?: boolean;
  rawOutputs?: string[];
  output?: unknown;
  validationIssues?: Array<{ code: string; message: string }>;
}

export interface Rate {
  k: number;
  n: number;
  rate: number | null;
  wilson: { low: number; high: number } | null;
}
const rate = (k: number, n: number): Rate => ({ k, n, rate: n === 0 ? null : k / n, wilson: wilson95(k, n, 1.96) });

export const GATES = { falsePositiveMax: 0.05, grammarRecallMin: 0.8, ambiguousAbstentionMin: 0.8, jsonValidMin: 0.98 } as const;

export interface ModelScore {
  model: string;
  /** which capability was exercised: Nimble = triage routing, Qwen = analysis */
  capability: "analysis" | "triage";
  jsonValidBeforeRepair: Rate;
  jsonValidAfterRepair: Rate;
  semanticValidBeforeRepair: Rate;
  semanticValidAfterRepair: Rate;
  /** expected correct but flagged as a grammar problem / routed to deep review */
  falsePositive: Rate;
  /** expected correct but the model declined to judge */
  falseAbstainOnCorrect: Rate;
  /** expected grammar_error and flagged */
  grammarRecall: Rate;
  /** among flagged grammar errors: the model named the expected skill (analysis only; null for triage) */
  taxonomyMatch: Rate | null;
  /** expected ambiguous and the model abstained / asked for deep review */
  ambiguousAbstention: Rate;
  /** expected ambiguous but confidently accepted or corrected (the worst failure) */
  ambiguousConfident: Rate;
  precision: Rate;
  coverage: Rate;
  errorAbstention: Rate;
  confusion: Record<Expected, Record<Predicted, number>>;
  perSplit: Record<"development" | "heldout", { falsePositive: Rate; grammarRecall: Rate; ambiguousAbstention: Rate; jsonValid: Rate; semanticValid: Rate }>;
  perGroup: Array<{ group: string; n: number; correctFlagged: number; errorsFlagged: number; errors: number; ambiguousAbstained: number; ambiguous: number }>;
  gate: { falsePositive: boolean; grammarRecall: boolean; ambiguousAbstention: boolean; jsonValid: boolean; all: boolean };
}

const emptyConfusion = (): ModelScore["confusion"] => ({
  correct: { accept: 0, flag: 0, abstain: 0, invalid: 0 },
  grammar_error: { accept: 0, flag: 0, abstain: 0, invalid: 0 },
  ambiguous: { accept: 0, flag: 0, abstain: 0, invalid: 0 },
});

/**
 * Scores ONE model on ONE warm pass over the cases. Triage (routing) counts `flag` as "needs deep review": for an ambiguous case that
 * is the right behaviour, so `flag` is accepted as an abstention-equivalent for Nimble but not for analysis.
 */
export function scoreModel(model: string, capability: "analysis" | "triage", cases: readonly BenchCase[], results: readonly CaseResult[]): ModelScore {
  const byId = new Map(cases.map((c) => [c.id, c]));
  for (const r of results) if (!byId.has(r.caseId)) throw new Error(`result for unknown case ${r.caseId}`);
  if (byId.size !== cases.length || new Set(results.map(r => r.caseId)).size !== results.length || results.length !== cases.length) throw new Error("benchmark requires exactly one result per distinct case, not repeated/incomplete samples");
  if (results.some(r => r.model !== model) || new Set(results.map(r => r.run)).size > 1 || new Set(results.map(r => r.phase)).size > 1) throw new Error("score one model and one pass at a time; repeats are stability samples, not independent evidence");
  const confusion = emptyConfusion();
  let vb = 0, va = 0, sb = 0, sa = 0;
  const schemaSplit = { development: [0,0], heldout: [0,0] } as Record<"development" | "heldout", [number,number]>;
  const semanticSplit = { development: [0,0], heldout: [0,0] } as Record<"development" | "heldout", [number,number]>;
  const stat = { fpK: 0, fpN: 0, fabK: 0, recK: 0, recN: 0, taxK: 0, taxN: 0, ambK: 0, ambN: 0, ambConf: 0 };
  const split = { development: { fp: [0, 0], rec: [0, 0], amb: [0, 0] }, heldout: { fp: [0, 0], rec: [0, 0], amb: [0, 0] } } as Record<"development" | "heldout", Record<"fp" | "rec" | "amb", [number, number]>>;
  const groups = new Map<string, ModelScore["perGroup"][number]>();
  const abstains = (p: Predicted) => p === "abstain" || (capability === "triage" && p === "flag");

  for (const r of results) {
    const c = byId.get(r.caseId);
    if (!c) throw new Error(`result for unknown case ${r.caseId}`);
    const schemaBefore = r.schemaValidBeforeRepair ?? r.validBeforeRepair;
    const schemaAfter = r.schemaValidAfterRepair ?? r.validAfterRepair;
    if (schemaBefore) vb++;
    if (schemaAfter) va++;
    if (r.validBeforeRepair) sb++;
    if (r.validAfterRepair) sa++;
    schemaSplit[c.split][1]++;
    semanticSplit[c.split][1]++;
    if (schemaBefore) schemaSplit[c.split][0]++;
    if (r.validAfterRepair) semanticSplit[c.split][0]++;
    confusion[c.expected][r.predicted]++;
    const g = groups.get(c.group) ?? { group: c.group, n: 0, correctFlagged: 0, errorsFlagged: 0, errors: 0, ambiguousAbstained: 0, ambiguous: 0 };
    g.n++;
    if (c.expected === "correct") {
      stat.fpN++;
      split[c.split].fp[1]++;
      if (r.predicted === "flag") (stat.fpK++, split[c.split].fp[0]++, g.correctFlagged++);
      if (r.predicted === "abstain") stat.fabK++;
    } else if (c.expected === "grammar_error") {
      stat.recN++;
      split[c.split].rec[1]++;
      g.errors++;
      if (r.predicted === "flag") {
        stat.recK++;
        split[c.split].rec[0]++;
        g.errorsFlagged++;
        if (capability === "analysis") {
          stat.taxN++;
          if (r.skills.includes(c.skill_id)) stat.taxK++;
        }
      }
    } else {
      stat.ambN++;
      split[c.split].amb[1]++;
      g.ambiguous++;
      if (abstains(r.predicted)) (stat.ambK++, split[c.split].amb[0]++, g.ambiguousAbstained++);
      else if (r.predicted === "accept" || r.predicted === "flag") stat.ambConf++;
    }
    groups.set(c.group, g);
  }
  const jsonValidBeforeRepair = rate(vb, results.length);
  const jsonValidAfterRepair = rate(va, results.length);
  const falsePositive = rate(stat.fpK, stat.fpN);
  const grammarRecall = rate(stat.recK, stat.recN);
  const ambiguousAbstention = rate(stat.ambK, stat.ambN);
  // Development examples may tune instructions; they must never rescue a failing held-out point gate.
  const held = split.heldout;
  const g = {
    falsePositive: (rate(...held.fp).rate ?? 1) <= GATES.falsePositiveMax,
    grammarRecall: (rate(...held.rec).rate ?? 0) >= GATES.grammarRecallMin,
    ambiguousAbstention: (rate(...held.amb).rate ?? 0) >= GATES.ambiguousAbstentionMin,
    jsonValid: (rate(...schemaSplit.heldout).rate ?? 0) >= GATES.jsonValidMin && semanticSplit.heldout[0] === semanticSplit.heldout[1],
  };
  return {
    model,
    capability,
    jsonValidBeforeRepair,
    jsonValidAfterRepair,
    semanticValidBeforeRepair: rate(sb, results.length),
    semanticValidAfterRepair: rate(sa, results.length),
    falsePositive,
    falseAbstainOnCorrect: rate(stat.fabK, stat.fpN),
    grammarRecall,
    taxonomyMatch: capability === "analysis" ? rate(stat.taxK, stat.taxN) : null,
    ambiguousAbstention,
    ambiguousConfident: rate(stat.ambConf, stat.ambN),
    precision: rate(stat.recK, results.filter(r => r.predicted === "flag").length),
    coverage: rate(results.filter(r => r.predicted === "flag" || r.predicted === "accept").length, results.length),
    errorAbstention: rate(confusion.grammar_error.abstain, stat.recN),
    confusion,
    perSplit: {
      development: { falsePositive: rate(...split.development.fp), grammarRecall: rate(...split.development.rec), ambiguousAbstention: rate(...split.development.amb), jsonValid: rate(...schemaSplit.development), semanticValid: rate(...semanticSplit.development) },
      heldout: { falsePositive: rate(...split.heldout.fp), grammarRecall: rate(...split.heldout.rec), ambiguousAbstention: rate(...split.heldout.amb), jsonValid: rate(...schemaSplit.heldout), semanticValid: rate(...semanticSplit.heldout) },
    },
    perGroup: [...groups.values()].sort((a, b) => (a.group < b.group ? -1 : 1)),
    gate: { ...g, all: g.falsePositive && g.grammarRecall && g.ambiguousAbstention && g.jsonValid },
  };
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}

/** Share of cases whose predicted class is identical in every pass (stability across repeated runs). */
export function stability(passes: ReadonlyArray<ReadonlyArray<CaseResult>>): { cases: number; stable: number; rate: number | null } {
  if (passes.length === 0) return { cases: 0, stable: 0, rate: null };
  const ids = new Set(passes.flatMap((p) => p.map((r) => r.caseId)));
  let stable = 0;
  for (const id of ids) {
    const preds = passes.map((p) => p.find((r) => r.caseId === id)?.predicted);
    if (preds.every((x) => x === preds[0] && x !== undefined)) stable++;
  }
  return { cases: ids.size, stable, rate: ids.size === 0 ? null : stable / ids.size };
}

export interface LatencySummary {
  n: number;
  p50: number | null;
  p95: number | null;
  medianTokensPerSecond: number | null;
}

export function latencySummary(results: readonly CaseResult[]): LatencySummary {
  const lat = results.map((r) => r.latencyMs);
  const tps = results.filter((r) => r.evalTokens && r.evalMs && r.evalMs > 0).map((r) => r.evalTokens! / (r.evalMs! / 1000));
  return { n: lat.length, p50: percentile(lat, 50), p95: percentile(lat, 95), medianTokensPerSecond: percentile(tps, 50) };
}
