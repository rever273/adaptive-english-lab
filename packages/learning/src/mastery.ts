/**
 * mastery-v1: pure, deterministic Mastery arithmetic (spec/04 "Формула mastery-v1").
 * No I/O, no clock, no randomness, no LLM: the same inputs always give bit-identical doubles.
 * Rounding to one decimal is a UI concern and never happens here.
 */

export const MASTERY_VERSION = "mastery-v1";

/** D65: provisional counting of decided local-AI verdicts at a lower weight (a new algorithm id; mastery-v1 is unchanged) */
export const MASTERY_V2_VERSION = "mastery-v2";
export const AI_CHECKED_WEIGHT = 0.5;

export interface MasteryConfig {
  version: string;
  /** D65 (mastery-v2 only): weight of an AI-checked (model-decided, never confirmed) opportunity relative to a code-confirmed one (1) */
  aiCheckedWeight?: number;
  /** last N eligible opportunities per skill x dimension x cohort */
  window: number;
  halfLifeDays: number;
  /** Beta(1,1) smoothing */
  priorSuccess: number;
  priorFailure: number;
  practiceWeight: number;
  heldoutWeight: number;
  insufficient: { minN: number; minDays: number; minNEff: number };
  stable: { minHeldout: number; minHeldoutDays: number; maxStaleDays: number };
  delayedProbeMinDays: number;
  weakBelow: number;
  stableAtLeast: number;
  maintenanceDelayedSuccessDays: number;
  summaryWeights: { recognition: number; correction: number; production: number };
  wilsonZ: number;
}

export const MASTERY_V1: MasteryConfig = {
  version: MASTERY_VERSION,
  window: 40,
  halfLifeDays: 60,
  priorSuccess: 1,
  priorFailure: 1,
  practiceWeight: 0.7,
  heldoutWeight: 0.3,
  insufficient: { minN: 12, minDays: 3, minNEff: 8 },
  stable: { minHeldout: 4, minHeldoutDays: 2, maxStaleDays: 30 },
  delayedProbeMinDays: 7,
  weakBelow: 6,
  stableAtLeast: 8,
  maintenanceDelayedSuccessDays: 2,
  summaryWeights: { recognition: 0.2, correction: 0.3, production: 0.5 },
  wilsonZ: 1.96,
};

/** mastery-v2 (D65): the same arithmetic; opportunities decided by the local AI count with `aiCheckedWeight`. Confirmed-only data gives the same numbers as v1. */
export const MASTERY_V2: MasteryConfig = { ...MASTERY_V1, version: MASTERY_V2_VERSION, aiCheckedWeight: AI_CHECKED_WEIGHT };

export type Dimension = "recognition" | "correction" | "production";
export type EvidenceStatus = "unknown" | "insufficient" | "developing" | "stale" | "stable";
export type EvidenceLabel = EvidenceStatus | "weak" | "improving" | "maintenance";

/** One eligible opportunity: confirmed, explicit target, independent first attempt, no hint, answer unseen. */
export interface EvidenceOpportunity {
  id: string;
  /** server timestamp of the attempt, ISO-8601 UTC */
  at: string;
  /** learning day in the session time zone */
  localDate: string;
  /** correct = true; incorrect and IDK = false */
  success: boolean;
  heldout: boolean;
  /** new prompt >= delayedProbeMinDays after the last practice of this skill (see markDelayedProbes) */
  delayedProbe: boolean;
  /** D65: relative weight of this opportunity (absent = 1); set only by mastery-v2 for AI-checked evidence */
  weight?: number;
}

export interface MasteryComponents {
  score: number | null;
  /** posterior accuracy over all selected opportunities */
  a: number | null;
  /** posterior accuracy over held-out + delayed probes only; equals `a` when there are none */
  h: number | null;
  hSource: "independent_check" | "no_independent_check" | null;
  n: number;
  days: number;
  nEff: number | null;
  sumW: number;
  sumW2: number;
  heldoutN: number;
  heldoutDays: number;
  delayedSuccessDays: number;
  successes: number;
  /** T_e: timestamp of the newest selected evidence; the score is anchored here, not to the clock */
  tE: string | null;
  lastSeen: string | null;
  asOf: string;
  wilson: { low: number; high: number } | null;
  status: EvidenceStatus;
  label: EvidenceLabel;
  selectedIds: string[];
  /** D65: how many of the selected opportunities are AI-checked (provisional); present only when there are some */
  aiCheckedN?: number;
}

const MS_PER_DAY = 86_400_000;
const t = (iso: string): number => {
  const v = Date.parse(iso);
  if (Number.isNaN(v)) throw new RangeError(`invalid timestamp: ${iso}`);
  return v;
};

/** Beta posterior mean with prior (1,1): (1 + sum w*y) / (2 + sum w). */
function posterior(cfg: MasteryConfig, sumWy: number, sumW: number): number {
  return (cfg.priorSuccess + sumWy) / (cfg.priorSuccess + cfg.priorFailure + sumW);
}

export function wilson95(successes: number, n: number, z: number): { low: number; high: number } | null {
  if (n <= 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/**
 * Delayed probe (spec/04): a new prompt for the same skill/dimension/cohort that comes >= 7 days after the last
 * earlier practice of that skill. `activityAt` lists every earlier practice moment (any attempt, assisted or not).
 */
export function markDelayedProbes<T extends { at: string }>(
  opportunities: readonly T[],
  activityAt: readonly string[],
  cfg: MasteryConfig = MASTERY_V1,
): Array<T & { delayedProbe: boolean }> {
  const times = activityAt.map(t).sort((x, y) => x - y);
  return opportunities.map((o) => {
    const at = t(o.at);
    let prev: number | null = null;
    for (const x of times) {
      if (x < at) prev = x;
      else break;
    }
    return { ...o, delayedProbe: prev !== null && (at - prev) / MS_PER_DAY >= cfg.delayedProbeMinDays };
  });
}

/** Score for one skill x dimension x cohort as of T. Eligibility filtering is the caller's job; windowing is here. */
export function computeComponents(all: readonly EvidenceOpportunity[], asOf: string, cfg: MasteryConfig = MASTERY_V1): MasteryComponents {
  const asOfMs = t(asOf);
  const eligible = all
    .filter((o) => t(o.at) <= asOfMs)
    .slice()
    .sort((x, y) => t(x.at) - t(y.at) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const sel = eligible.slice(-cfg.window);
  const n = sel.length;
  if (n === 0) {
    return {
      score: null, a: null, h: null, hSource: null, n: 0, days: 0, nEff: null, sumW: 0, sumW2: 0, heldoutN: 0, heldoutDays: 0,
      delayedSuccessDays: 0, successes: 0, tE: null, lastSeen: null, asOf, wilson: null, status: "unknown", label: "unknown", selectedIds: [],
    };
  }

  const tE = sel.reduce((m, o) => Math.max(m, t(o.at)), -Infinity);
  let sumW = 0;
  let sumW2 = 0;
  let sumWy = 0;
  let indW = 0;
  let indWy = 0;
  let successes = 0;
  let heldoutN = 0;
  let aiCheckedN = 0;
  const days = new Set<string>();
  const heldoutDays = new Set<string>();
  const delayedSuccessDays = new Set<string>();
  for (const o of sel) {
    const age = Math.max(0, (tE - t(o.at)) / MS_PER_DAY);
    const w = o.weight === undefined ? Math.pow(2, -age / cfg.halfLifeDays) : Math.pow(2, -age / cfg.halfLifeDays) * o.weight;
    if (o.weight !== undefined && o.weight < 1) aiCheckedN += 1;
    const y = o.success ? 1 : 0;
    sumW += w;
    sumW2 += w * w;
    sumWy += w * y;
    successes += y;
    days.add(o.localDate);
    if (o.heldout || o.delayedProbe) {
      indW += w;
      indWy += w * y;
    }
    if (o.heldout) {
      heldoutN += 1;
      heldoutDays.add(o.localDate);
    }
    if (o.delayedProbe && o.success) delayedSuccessDays.add(o.localDate);
  }

  const a = posterior(cfg, sumWy, sumW);
  const hasIndependent = sel.some((o) => o.heldout || o.delayedProbe);
  const h = hasIndependent ? posterior(cfg, indWy, indW) : a;
  const score = 10 * (cfg.practiceWeight * a + cfg.heldoutWeight * h);
  const nEff = (sumW * sumW) / sumW2;
  const lastSeenMs = Math.max(...sel.map((o) => t(o.at)));
  const staleDays = (asOfMs - lastSeenMs) / MS_PER_DAY;

  const base = n >= cfg.insufficient.minN && days.size >= cfg.insufficient.minDays && nEff >= cfg.insufficient.minNEff;
  let status: EvidenceStatus;
  if (!base) status = "insufficient";
  else if (staleDays > cfg.stable.maxStaleDays) status = "stale";
  else if (heldoutN < cfg.stable.minHeldout || heldoutDays.size < cfg.stable.minHeldoutDays) status = "developing";
  else status = "stable";

  let label: EvidenceLabel = status;
  if (status === "stable") {
    if (score < cfg.weakBelow) label = "weak";
    else if (score < cfg.stableAtLeast) label = "improving";
    else label = delayedSuccessDays.size >= cfg.maintenanceDelayedSuccessDays ? "maintenance" : "stable";
  }

  return {
    score,
    a,
    h,
    hSource: hasIndependent ? "independent_check" : "no_independent_check",
    n,
    days: days.size,
    nEff,
    sumW,
    sumW2,
    heldoutN,
    heldoutDays: heldoutDays.size,
    delayedSuccessDays: delayedSuccessDays.size,
    successes,
    tE: new Date(tE).toISOString(),
    lastSeen: new Date(lastSeenMs).toISOString(),
    asOf,
    wilson: wilson95(successes, n, cfg.wilsonZ),
    status,
    label,
    selectedIds: sel.map((o) => o.id),
    ...(aiCheckedN > 0 ? { aiCheckedN } : {}),
  };
}

export interface SkillSummary {
  score: number | null;
  /** why there is no summary: some dimension lacks stable evidence */
  reason: "ok" | "insufficient_dimensions";
  missing: Dimension[];
}

/** Summary = .2R + .3C + .5P only when all three dimensions have stable evidence (recognition never stands in for production). */
export function summarizeSkill(dims: Partial<Record<Dimension, Pick<MasteryComponents, "score" | "status">>>, cfg: MasteryConfig = MASTERY_V1): SkillSummary {
  const order: Dimension[] = ["recognition", "correction", "production"];
  const missing = order.filter((d) => dims[d]?.status !== "stable" || dims[d]?.score == null);
  if (missing.length > 0) return { score: null, reason: "insufficient_dimensions", missing };
  const score = order.reduce((acc, d) => acc + cfg.summaryWeights[d] * (dims[d]!.score as number), 0);
  return { score, reason: "ok", missing: [] };
}

/** UI-only rounding to one decimal. */
export const displayScore = (s: number | null): number | null => (s === null ? null : Math.round(s * 10) / 10);

/** Canonical JSON (sorted keys) so config/input hashes are stable across runs and machines. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}
