import { createHash } from "node:crypto";
import type { BenchCase, CaseResult } from "./benchmark.js";

/** Development-only exploration, not a probability calibrator or an automatic config writer. */
export function exploreRoutingThresholds(cases: readonly BenchCase[], results: readonly CaseResult[]) {
  const dev = cases.filter(c => c.split === "development");
  const byId = new Map(results.map(r => [r.caseId,r]));
  if (byId.size !== results.length) throw new Error("use exactly one pass; repeats cannot increase calibration sample size");
  const rows = dev.map(c => ({ c, p: byId.get(c.id)?.reviewProbability }));
  if (rows.some(r => typeof r.p !== "number" || !Number.isFinite(r.p) || r.p < 0 || r.p > 1)) throw new Error("development scores missing/invalid; no fallback to labels or heldout scores");
  const metrics = (subset: typeof rows, t: number) => {
    const positive = subset.filter(r=>r.c.expected !== "correct");
    const negative = subset.filter(r=>r.c.expected === "correct");
    return { reviewRecall: positive.length ? positive.filter(r=>r.p!>=t).length/positive.length : null,
      correctRouted: negative.length ? negative.filter(r=>r.p!>=t).length/negative.length : null };
  };
  const groups = [...new Set(dev.map(c=>c.group))].sort();
  const curve = [.05,.1,.2,.35,.5,.65,.8].map(threshold => ({ threshold, ...metrics(rows,threshold),
    leaveOneGroupOut: groups.map(group => ({ excluded:group, ...metrics(rows.filter(r=>r.c.group!==group),threshold) })) }));
  const correct = dev.filter(c=>c.expected === "correct").length;
  const errors = dev.filter(c=>c.expected === "grammar_error").length;
  return { version:"routing-exploration-v1", role:"advisory routing, never learner-error verdict", independentCases:dev.length,
    correct,errors,groups:groups.length,curve,
    calibrationInputHash:createHash("sha256").update(JSON.stringify(rows.map(r=>[r.c.id,r.c.group,r.c.expected,r.p]))).digest("hex"),
    status:correct<100 || errors<50 || groups.length<10 ? "insufficient_evidence" : "requires_independent_validation",
    recommendedThreshold:null,runtimeRoutingEnabled:false,
    note:"No automatic threshold deployment. Holdout scores/labels excluded. Review score is not a calibrated probability of grammar error." };
}
