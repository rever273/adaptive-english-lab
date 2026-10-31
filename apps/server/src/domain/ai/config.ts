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
  version: "ai-config-v1" | "ai-config-v2" | "ai-config-v3";
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
 * gemma4:12b = see its entry below (num_ctx 8192). nimble-v3 = 11756 - ~2000 = 9750 MiB (TASK_009 benchmark, D49): it was recorded in the decision log but missing here, so the advisory
 * draft screens queued by every generation batch waited forever as profile_unknown (D64).
 * Admission = free >= measured peak + reserve. A model without an entry here never starts in profiled mode.
 */
export const MEASURED_ADDITIONAL_PEAK_MIB: Record<string, number> = {
  "qwen3:8b": 6215,
  "qwen3:14b": 10335,
  "nimble-v3:latest": 9750,
  // TASK_023, nvidia-smi above the ~1.5 GB desktop baseline at num_ctx 8192, think:false: +10014 MiB loaded and idle, +10027 during real analyses,
  // +10136 with a 4185-token prompt. 10250 leaves a small margin for the largest prompt the analysis guard allows (~5200 tokens, not measured).
  "gemma4:12b": 10250,
};

/** D67: the ONE local model of the application (answer checking, vocabulary, drafts, tutor). Qwen and Nimble are not used by the app. */
export const LOCAL_MODEL_TAG = "gemma4:12b";
export const LOCAL_MODEL_DIGEST = "6114515d63c17436a7c0417d82820ac65ad643e2806c5a3c89cb62846436ed0b";
/** how long Ollama keeps the model after the last call; every job and every warm-up refreshes it */
export const MODEL_KEEP_ALIVE = "30m";
/**
 * ONE context for the warm-up and for every job kind. Measured (TASK_023): a different num_ctx makes Ollama reload the model (~8.6 s each time), so
 * per-kind values would reload it on every switch between analysis, words, drafts and tutor. 8192 covers the largest analysis prompt the
 * 12000-character guard allows (5157 tokens measured) + numPredict 768 with ~25% margin; the other kinds need far less (see the table in TASK_023).
 * Cost over 4096: ~180 MiB of VRAM.
 */
export const RESIDENT_NUM_CTX = 8192;

export const AI_CONFIG_V3: AiConfig = {
  version: "ai-config-v3",
  analysis: { tag: LOCAL_MODEL_TAG, digest: LOCAL_MODEL_DIGEST, numCtx: RESIDENT_NUM_CTX, temperature: 0, seed: 42, numPredict: 768 },
  triage: { enabled: false, tag: LOCAL_MODEL_TAG, digest: LOCAL_MODEL_DIGEST, disabledReason: "Nimble is not used by the application (D67); advisory screening is off." },
};
