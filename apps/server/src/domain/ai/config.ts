import { createHash } from "node:crypto";

/**
 * Model configuration (spec/06, spec/02): tag + digest are pinned. A digest that differs from the installed one is a drift: the
 * runner refuses to run (routing disabled, annotations kept) instead of silently using another model.
 */
export interface PinnedModel {
  tag: string;
  /** Ollama digest as reported by /api/tags (no "sha256:" prefix) */
  digest: string;
  numCtx: number;
  temperature: number;
  seed: number;
}

export interface AiConfig {
  version: "ai-config-v1" | "ai-config-v2";
  /** full-text analysis; always tentative output */
  analysis: PinnedModel & { numPredict: number };
  /** Nimble triage routing: disabled until the benchmark gate passes (spec/06: "Nimble disabled до probe") */
  triage: { enabled: boolean; tag: string; digest: string; disabledReason: string | null };
}

export const AI_CONFIG_V1: AiConfig = {
  version: "ai-config-v1",
  analysis: {
    tag: "qwen3:8b",
    digest: "500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41",
    numCtx: 4096,
    temperature: 0.2,
    seed: 42,
    numPredict: 1024,
  },
  triage: {
    enabled: false,
    tag: "nimble-v3:latest",
    digest: "6f0e87f398007002ca6de5899f8e62c0826a4e8b723b4fc533526ef9c2b2c487",
    disabledReason: "benchmark quality gate not passed (TASK_009: gold labels are not independently adjudicated)",
  },
};

export const AI_CONFIG_V2: AiConfig = {
  ...AI_CONFIG_V1,
  version: "ai-config-v2",
  analysis: { ...AI_CONFIG_V1.analysis, temperature: 0, numPredict: 768 },
  triage: { ...AI_CONFIG_V1.triage, enabled: false, disabledReason: "Advisory only; no validated screening threshold. Every open answer remains eligible for Qwen; provisional/model qualification requires independent labels and a fresh test set." },
};

/** Hash of the generation parameters that affect memory/latency: the key of a measured GPU profile (spec/07). */
export const configHashOf = (m: Pick<PinnedModel, "numCtx"> & { numPredict?: number }): string =>
  createHash("sha256").update(JSON.stringify({ num_ctx: m.numCtx, num_predict: m.numPredict ?? null })).digest("hex").slice(0, 16);

/**
 * Measured ADDITIONAL peak VRAM (whole-card peak minus the desktop baseline) from real runs on this machine (RTX 5060 Ti 16 GiB):
 * qwen3:8b ctx 4096 = 8215 - 2000 = 6215 MiB (TASK_008 verify:gpu 2026-10-28); qwen3:14b = 12271 - 1936 = 10335 MiB (TASK_002).
 * nimble-v3 = 11756 - ~2000 = 9750 MiB (TASK_009 benchmark, D49): it was recorded in the decision log but missing here, so the advisory
 * draft screens queued by every generation batch waited forever as profile_unknown (D64).
 * Admission = free >= measured peak + reserve. A model without an entry here never starts in profiled mode.
 */
export const MEASURED_ADDITIONAL_PEAK_MIB: Record<string, number> = {
  "qwen3:8b": 6215,
  "qwen3:14b": 10335,
  "nimble-v3:latest": 9750,
};
