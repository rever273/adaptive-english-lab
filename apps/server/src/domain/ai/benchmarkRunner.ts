import type { JobRunner, RunnerContext, RunnerOutput } from "../../queue/types.js";
import { createHash } from "node:crypto";
import type { ChatClient, DecisionClient } from "./clients.js";
import { buildGrammarBenchmarkUserMessage, ANALYSIS_SYSTEM_V3, NIMBLE_TRIAGE_V3 } from "./prompts.js";
import { runStructured } from "./structured.js";
import { schemaVariant, validateAiOutput, isSchemaValidOutput, type AnalysisV2 } from "./validate.js";
import type { BenchCase, CaseResult, Predicted } from "./benchmark.js";
import { AI_CONFIG_V2 } from "./config.js";

export interface BenchmarkPayload {
  model: string;
  capability: "analysis" | "triage";
  phase: "warm" | "cold";
  run: number;
  cases: BenchCase[];
  allowedSkillIds: string[];
}

export interface BenchmarkOptions {
  chat: ChatClient;
  decision: DecisionClient;
  sleep?: (ms: number) => Promise<void>;
}


/**
 * Runs one pass of benchmark cases for one model as ONE dispatcher unit (so it is subject to the same single-GPU rule as every other
 * job). Cases are committed to the checkpoint item by item; outputs are the raw material for scoring, never training data.
 */
export class BenchmarkRunner implements JobRunner<BenchmarkPayload> {
  readonly kind = "benchmark" as const;
  constructor(private readonly o: BenchmarkOptions) {}
  ownedModels(job: { payload: unknown }): string[] {
    return [(job.payload as BenchmarkPayload).model];
  }
  profileKey() {
    return null; // controlled spike: the benchmark measures the profile itself
  }

  async run(ctx: RunnerContext<BenchmarkPayload>): Promise<RunnerOutput> {
    const p = ctx.job.payload;
    const saved = ctx.job.checkpoint as { results?: CaseResult[] } | undefined;
    const results: CaseResult[] = [...(saved?.results ?? [])];
    if (results.some((r,i) => r.caseId !== p.cases[i]?.id || r.model !== p.model)) throw new Error("checkpoint does not match benchmark payload");
    const allowed = new Set(p.allowedSkillIds);
    for (const [i, c] of p.cases.entries()) {
      if (i < results.length) continue;
      if (ctx.signal.aborted) throw new DOMException("aborted", "AbortError");
      results.push(p.capability === "triage" ? await this.triage(p, c, ctx.signal) : await this.analyse(p, c, allowed, ctx.signal));
      ctx.checkpoint({ done: i + 1, total: p.cases.length, results });
    }
    return { schemaVersion: "benchmark-pass-v1", output: { model: p.model, run: p.run, phase: p.phase, results }, metrics: { cases: results.length } };
  }

  private async triage(p: BenchmarkPayload, c: BenchCase, signal: AbortSignal): Promise<CaseResult> {
    const started = Date.now();
    const d = await this.o.decision.decide({ model: p.model, text: c.text, instructions: NIMBLE_TRIAGE_V3.instructions, criteria: NIMBLE_TRIAGE_V3.criteria, signal });
    // Experimental advisory score only; never a gate that skips analysis of an open answer.
    const pReview = d.probabilities.review;
    const predicted: Predicted = (pReview === undefined ? d.choice === "review" : pReview >= NIMBLE_TRIAGE_V3.reviewThreshold) ? "flag" : "accept";
    return { caseId: c.id, model: p.model, run: p.run, phase: p.phase, predicted, skills: [], validBeforeRepair: true, validAfterRepair: true, latencyMs: Date.now() - started, loadMs: null, evalTokens: null, evalMs: null, rawJudgement: `${d.choice}:${(pReview ?? -1).toFixed(3)}`, reviewProbability: pReview, rawOutputs: [JSON.stringify(d)] };
  }

  private async analyse(p: BenchmarkPayload, c: BenchCase, allowed: Set<string>, signal: AbortSignal): Promise<CaseResult> {
    // IDs such as B02E encode the author's class convention; never expose that to a model.
    const attemptId = createHash("sha256").update(`benchmark-opaque-v1:${c.id}`).digest("hex").slice(0,24);
    const user = buildGrammarBenchmarkUserMessage(attemptId, c.text, [...allowed]);
    const m = AI_CONFIG_V2.analysis;
    const started = Date.now();
    const r = await runStructured<AnalysisV2>({
      client: this.o.chat,
      model: p.model,
      messages: [
        { role: "system", content: ANALYSIS_SYSTEM_V3 },
        { role: "user", content: user },
      ],
      format: schemaVariant("analysis-v2"),
      options: { num_ctx: m.numCtx, num_predict: m.numPredict, temperature: m.temperature, seed: m.seed },
      validate: (t) => validateAiOutput(t, "analysis-v2", { attemptId, submittedText: c.text, allowedSkillIds: allowed }),
      schemaValid: (t) => isSchemaValidOutput(t, "analysis-v2"),
      signal,
      sleep: this.o.sleep,
    });
    const last = r.usage.stats.at(-1);
    const first = r.usage.stats[0];
    if (!r.ok) {
      return { caseId: c.id, model: p.model, run: p.run, phase: p.phase, predicted: "invalid", skills: [], validBeforeRepair: false, validAfterRepair: false, latencyMs: Date.now() - started, loadMs: first?.loadMs ?? null, evalTokens: last?.evalTokens ?? null, evalMs: last?.evalMs ?? null, rawJudgement: `invalid:${r.issues[0]?.code ?? ""}`, schemaValidBeforeRepair: r.usage.schemaValidBeforeRepair, schemaValidAfterRepair: r.usage.schemaValidAfterRepair, rawOutputs: r.usage.rawOutputs, validationIssues: r.issues };
    }
    const j = r.value.judgement;
    const predicted: Predicted = j === "acceptable" ? "accept" : j === "incorrect_candidate" ? "flag" : "abstain";
    return {
      caseId: c.id,
      model: p.model,
      run: p.run,
      phase: p.phase,
      predicted,
      skills: [...new Set(r.value.findings.filter((f) => f.kind === "grammar").map((f) => f.skill_id))],
      validBeforeRepair: r.usage.validBeforeRepair,
      validAfterRepair: r.usage.validAfterRepair,
      latencyMs: Date.now() - started,
      loadMs: first?.loadMs ?? null,
      evalTokens: last?.evalTokens ?? null,
      evalMs: last?.evalMs ?? null,
      rawJudgement: j,
      schemaValidBeforeRepair: r.usage.schemaValidBeforeRepair,
      schemaValidAfterRepair: r.usage.schemaValidAfterRepair,
      rawOutputs: r.usage.rawOutputs,
      output: r.value,
    };
  }
}
