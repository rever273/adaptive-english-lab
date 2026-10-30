import { describe, expect, it } from "vitest";
import { TransportError, type CallStats, type ChatClient, type ChatResult } from "../../../apps/server/src/domain/ai/clients.js";
import { MAX_CALLS, TRANSPORT_DELAYS_MS, runStructured } from "../../../apps/server/src/domain/ai/structured.js";
import { GATES, latencySummary, percentile, scoreModel, stability, type BenchCase, type CaseResult, type Predicted } from "../../../apps/server/src/domain/ai/benchmark.js";
import type { Validated } from "../../../apps/server/src/domain/ai/validate.js";

const stats: CallStats = { totalMs: 10, loadMs: null, promptTokens: 5, evalTokens: 5, evalMs: 5 };
type Step = string | Error;
function scripted(steps: Step[]): ChatClient & { calls: Array<{ messages: Array<{ role: string; content: string }> }> } {
  const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  let i = 0;
  return {
    calls,
    async chat(req): Promise<ChatResult> {
      calls.push({ messages: req.messages });
      const s = steps[Math.min(i++, steps.length - 1)]!;
      if (s instanceof Error) throw s;
      return { text: s, stats };
    },
  };
}
const validate = (text: string): Validated<{ n: number }> => {
  try {
    const v = JSON.parse(text) as { n?: unknown };
    return typeof v.n === "number" ? { ok: true, value: { n: v.n }, issues: [] } : { ok: false, value: null, issues: [{ code: "SCHEMA", message: "n must be a number" }] };
  } catch {
    return { ok: false, value: null, issues: [{ code: "NOT_JSON", message: "not json" }] };
  }
};
const base = { model: "m", messages: [{ role: "user" as const, content: "x" }], format: {}, options: { num_ctx: 4096, num_predict: 100, temperature: 0.2 }, validate };
const delays: number[] = [];
const sleep = async (ms: number) => void delays.push(ms);
const transient = () => new TransportError("ollama_unreachable", "down", true);

describe("runStructured: the retry policy of spec/06", () => {
  it("a valid first output is used as is (counts as valid BEFORE repair)", async () => {
    const r = await runStructured({ ...base, client: scripted(['{"n":1}']) });
    expect(r).toMatchObject({ ok: true, value: { n: 1 }, usage: { calls: 1, repaired: false, validBeforeRepair: true, validAfterRepair: true } });
  });

  it("an invalid output gets exactly ONE repair request carrying only the errors, then failed_validation", async () => {
    const c = scripted(["not json", "still not json"]);
    const r = await runStructured({ ...base, client: c });
    expect(r).toMatchObject({ ok: false, code: "failed_validation", usage: { calls: 2, repaired: true, validBeforeRepair: false, validAfterRepair: false } });
    expect(c.calls).toHaveLength(2);
    const repair = c.calls[1]!.messages;
    expect(repair.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(repair[2]!.content).toContain("NOT_JSON");
    expect(repair[2]!.content).not.toMatch(/think|reason step by step|chain of thought/i); // no hidden chain of thought requested
  });

  it("repair can succeed: valid after repair but NOT before", async () => {
    const r = await runStructured({ ...base, client: scripted(['{"n":"x"}', '{"n":2}']) });
    expect(r).toMatchObject({ ok: true, value: { n: 2 }, usage: { repaired: true, validBeforeRepair: false, validAfterRepair: true } });
  });

  it("transport errors are retried after 2 s then 5 s; the third failure ends it (budget: 3 calls)", async () => {
    delays.length = 0;
    const c = scripted([transient(), transient(), transient()]);
    const r = await runStructured({ ...base, client: c, sleep });
    expect(r).toMatchObject({ ok: false, code: "transport_failed", usage: { calls: 3, transportRetries: 2 } });
    expect(delays).toEqual(TRANSPORT_DELAYS_MS);
    expect(MAX_CALLS).toBe(3);
  });

  it("a transport error followed by success is a success on the second call", async () => {
    delays.length = 0;
    const r = await runStructured({ ...base, client: scripted([transient(), '{"n":3}']), sleep });
    expect(r).toMatchObject({ ok: true, usage: { calls: 2, transportRetries: 1 } });
    expect(delays).toEqual([2000]);
  });

  it("the repair request shares the 3-call budget with transport retries", async () => {
    delays.length = 0;
    const c = scripted([transient(), "garbage", transient()]);
    const r = await runStructured({ ...base, client: c, sleep });
    expect(r.ok).toBe(false);
    expect(c.calls.length).toBeLessThanOrEqual(MAX_CALLS);
  });

  it("a non-transient error is not retried", async () => {
    const c = scripted([new TransportError("ollama_http", "404", false)]);
    const r = await runStructured({ ...base, client: c, sleep });
    expect(r).toMatchObject({ ok: false, code: "transport_failed", usage: { calls: 1, transportRetries: 0 } });
  });

  it("cancellation is neither a failure nor retried", async () => {
    const ctl = new AbortController();
    const c = scripted(['{"n":1}']);
    ctl.abort();
    await expect(runStructured({ ...base, client: c, signal: ctl.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(c.calls).toHaveLength(0);
    const aborting = scripted([Object.assign(new Error("aborted"), { name: "AbortError" })]);
    await expect(runStructured({ ...base, client: aborting })).rejects.toMatchObject({ name: "AbortError" });
    expect(aborting.calls).toHaveLength(1);
  });
});

describe("benchmark scoring (spec/BENCHMARK.md)", () => {
  const mk = (id: string, group: string, expected: BenchCase["expected"], split: BenchCase["split"] = "development"): BenchCase => ({ id, group, topic: "t", text: id, expected, skill_id: "s.k", split });
  const res = (caseId: string, predicted: Predicted, o: Partial<CaseResult> = {}): CaseResult => ({ caseId, model: "m", run: 0, phase: "warm", predicted, skills: [], validBeforeRepair: true, validAfterRepair: true, latencyMs: 100, loadMs: null, evalTokens: 10, evalMs: 100, rawJudgement: predicted, ...o });
  const cases = [mk("c1", "G1", "correct"), mk("c2", "G1", "correct", "heldout"), mk("e1", "G1", "grammar_error"), mk("e2", "G2", "grammar_error", "heldout"), mk("a1", "G2", "ambiguous", "heldout")];

  it("counts false positives, recall, taxonomy match and abstention exactly, with Wilson intervals", () => {
    const s = scoreModel("m", "analysis", cases, [res("c1", "accept"), res("c2", "flag"), res("e1", "flag", { skills: ["s.k"] }), res("e2", "accept"), res("a1", "abstain")]);
    expect(s.falsePositive).toMatchObject({ k: 1, n: 2, rate: 0.5 });
    expect(s.grammarRecall).toMatchObject({ k: 1, n: 2, rate: 0.5 });
    expect(s.taxonomyMatch).toMatchObject({ k: 1, n: 1 });
    expect(s.ambiguousAbstention).toMatchObject({ k: 1, n: 1 });
    expect(s.ambiguousConfident.k).toBe(0);
    expect(s.confusion.correct).toEqual({ accept: 1, flag: 1, abstain: 0, invalid: 0 });
    expect(s.falsePositive.wilson!.low).toBeGreaterThan(0);
    expect(s.falsePositive.wilson!.high).toBeLessThan(1);
    expect(s.perSplit.heldout.grammarRecall).toMatchObject({ k: 0, n: 1 });
    expect(s.perSplit.development.falsePositive).toMatchObject({ k: 0, n: 1 });
    expect(s.perGroup.find((g) => g.group === "G1")).toMatchObject({ n: 3, correctFlagged: 1, errors: 1, errorsFlagged: 1 });
    expect(s.gate.all).toBe(false);
  });

  it("a confident correction of an ambiguous case is the worst outcome and is counted separately from abstention", () => {
    const s = scoreModel("m", "analysis", cases, [res("c1", "accept"), res("c2", "accept"), res("e1", "flag"), res("e2", "flag"), res("a1", "flag")]);
    expect(s.ambiguousAbstention.k).toBe(0);
    expect(s.ambiguousConfident.k).toBe(1);
    expect(s.gate).toMatchObject({ falsePositive: true, grammarRecall: true, ambiguousAbstention: false, all: false });
  });

  it("for triage (Nimble routing) `flag` means deep review, which IS the right answer for an ambiguous case", () => {
    const s = scoreModel("n", "triage", cases, [res("c1", "accept"), res("c2", "accept"), res("e1", "flag"), res("e2", "flag"), res("a1", "flag")].map(r=>({...r,model:"n"})));
    expect(s.ambiguousAbstention).toMatchObject({ k: 1, n: 1 });
    expect(s.taxonomyMatch).toBeNull();
  });

  it("gates are the spec numbers and JSON validity is measured BEFORE repair", () => {
    expect(GATES).toEqual({ falsePositiveMax: 0.05, grammarRecallMin: 0.8, ambiguousAbstentionMin: 0.8, jsonValidMin: 0.98 });
    const s = scoreModel("m", "analysis", cases, cases.map((c) => res(c.id, "accept", { validBeforeRepair: c.id !== "e2", validAfterRepair: true })));
    expect(s.jsonValidBeforeRepair).toMatchObject({ k: 4, n: 5 });
    expect(s.jsonValidAfterRepair).toMatchObject({ k: 5, n: 5 });
    expect(s.gate.jsonValid).toBe(false);
  });

  it("invalid outputs are never counted as accept or as flag", () => {
    const s = scoreModel("m", "analysis", cases, cases.map((c) => res(c.id, "invalid", { validBeforeRepair: false, validAfterRepair: false })));
    expect(s.confusion.correct).toEqual({ accept: 0, flag: 0, abstain: 0, invalid: 2 });
    expect(s.falsePositive.k).toBe(0);
    expect(s.grammarRecall.k).toBe(0);
  });

  it("rejects results for unknown cases", () => {
    expect(() => scoreModel("m", "analysis", cases, [res("zzz", "accept")])).toThrow(/unknown case/);
  });

  it("percentiles, latency and stability across repeated passes", () => {
    expect(percentile([1, 2, 3, 4, 100], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 100], 95)).toBe(100);
    expect(percentile([], 50)).toBeNull();
    const a = [res("c1", "accept", { latencyMs: 100, evalTokens: 50, evalMs: 1000 }), res("c2", "flag", { latencyMs: 300, evalTokens: 100, evalMs: 1000 })];
    expect(latencySummary(a)).toMatchObject({ n: 2, p50: 100, p95: 300, medianTokensPerSecond: 50 });
    const b = [res("c1", "accept"), res("c2", "accept")];
    expect(stability([a, b])).toEqual({ cases: 2, stable: 1, rate: 0.5 });
    expect(stability([a, a])).toEqual({ cases: 2, stable: 2, rate: 1 });
    expect(stability([])).toEqual({ cases: 0, stable: 0, rate: null });
  });
});
