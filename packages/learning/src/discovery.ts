/**
 * discovery-v1 (spec/04 "Provisional discovery"): a bounded signal that suggests WHICH approved probe to show next.
 * It is independent of mastery-v1: it never touches Mastery, confirmed accuracy or verified error rate.
 * Pure projection; no model is called here. Until the TASK_009 quality gate, `qualifiedModels` is empty and the
 * whole signal is off.
 */

export const DISCOVERY_VERSION = "discovery-v1";

export interface DiscoveryConfig {
  version: typeof DISCOVERY_VERSION;
  windowDays: number;
  confidenceMin: number;
  minAttempts: number;
  minContexts: number;
  bonusPerAttempt: number;
  bonusCap: number;
  maxProbesAbsolute: number;
  maxProbesFraction: number;
  /** Models that passed the quality gate: key = `${tag}@${digest}`. Empty = discovery disabled. */
  qualifiedModels: Array<{ key: string; qualificationId: string }>;
}

export const DISCOVERY_V1: DiscoveryConfig = {
  version: DISCOVERY_VERSION,
  windowDays: 30,
  confidenceMin: 0.8,
  minAttempts: 2,
  minContexts: 2,
  bonusPerAttempt: 0.025,
  bonusCap: 0.1,
  maxProbesAbsolute: 2,
  maxProbesFraction: 0.15,
  qualifiedModels: [],
};

export type FindingVerdict = "confirmed" | "tentative" | "uncertain" | "disputed" | "rejected";

export interface FindingSignal {
  findingId: string;
  attemptId: string;
  skillId: string;
  /** exercise context_id of the slot where the finding arose */
  contextId: string;
  confidence: number | null;
  findingType: "grammar" | "style" | "ambiguity";
  /** latest review event, else the original verdict */
  effectiveVerdict: FindingVerdict;
  skillKnown: boolean;
  /** `${tag}@${digest}` of the producing model, null for non-model findings */
  modelKey: string | null;
  /** attempt submitted_at */
  at: string;
  firstAttempt: boolean;
  /** the finding belongs to the latest assessment revision of its attempt (re-delivery of old output does not count) */
  latestAnalysis: boolean;
}

export interface DiscoverySkillResult {
  skillId: string;
  /** distinct qualifying first attempts */
  k: number;
  contexts: number;
  bonus: number;
  /** one finding per counted attempt, sorted: audit trail for scheduling_decisions */
  sourceFindingIds: string[];
  qualificationIds: string[];
}

const MS_PER_DAY = 86_400_000;

/**
 * One vote per attempt per skill. Needs >= minAttempts attempts AND >= minContexts contexts after the last confirmed
 * probe of that skill, inside the window. Anything unqualified, style/ambiguity, low-confidence, uncertain, rejected or
 * disputed contributes nothing. bonus = min(cap, per * k) for k >= 2, else 0.
 */
export function computeDiscovery(
  findings: readonly FindingSignal[],
  lastConfirmedProbeAt: Readonly<Record<string, string>>,
  asOf: string,
  cfg: DiscoveryConfig = DISCOVERY_V1,
): DiscoverySkillResult[] {
  const asOfMs = Date.parse(asOf);
  const qualified = new Map(cfg.qualifiedModels.map((m) => [m.key, m.qualificationId]));
  const perSkill = new Map<string, Map<string, FindingSignal>>();
  for (const f of findings) {
    if (f.findingType !== "grammar" || f.effectiveVerdict !== "tentative" || !f.skillKnown) continue;
    if (f.confidence === null || f.confidence < cfg.confidenceMin) continue;
    if (f.modelKey === null || !qualified.has(f.modelKey)) continue;
    if (!f.firstAttempt || !f.latestAnalysis) continue;
    const at = Date.parse(f.at);
    if (!(at <= asOfMs && asOfMs - at <= cfg.windowDays * MS_PER_DAY)) continue;
    const probe = lastConfirmedProbeAt[f.skillId];
    if (probe !== undefined && at <= Date.parse(probe)) continue;
    const byAttempt = perSkill.get(f.skillId) ?? new Map<string, FindingSignal>();
    const prev = byAttempt.get(f.attemptId);
    if (!prev || f.findingId < prev.findingId) byAttempt.set(f.attemptId, f); // deterministic representative
    perSkill.set(f.skillId, byAttempt);
  }
  const out: DiscoverySkillResult[] = [];
  for (const [skillId, byAttempt] of [...perSkill.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const used = [...byAttempt.values()];
    const k = used.length;
    const contexts = new Set(used.map((f) => f.contextId)).size;
    const ok = k >= cfg.minAttempts && contexts >= cfg.minContexts;
    out.push({
      skillId,
      k,
      contexts,
      bonus: ok ? Math.min(cfg.bonusCap, cfg.bonusPerAttempt * k) : 0,
      sourceFindingIds: used.map((f) => f.findingId).sort(),
      qualificationIds: [...new Set(used.map((f) => qualified.get(f.modelKey!)!))].sort(),
    });
  }
  return out;
}

export interface ProbeCandidate {
  skillId: string;
  /** base priority P (spec/04) before the agent multiplier */
  basePriority: number;
  planMultiplier: number;
  dimension: "recognition" | "correction" | "production";
  bankRole: "practice" | "diagnostic" | "heldout";
}

export interface RankedCandidate {
  skillId: string;
  pSelect: number;
  /** bonus actually applied (0 for production/held-out candidates) */
  bonus: number;
}

/**
 * P_select = P * plan_multiplier + B_s for eligible approved recognition/correction probes from practice/diagnostic banks.
 * The bonus is not multiplied by the agent multiplier and never applies to production or held-out. Ties: skillId.
 */
export function rankProbeCandidates(candidates: readonly ProbeCandidate[], bonusBySkill: Readonly<Record<string, number>>): RankedCandidate[] {
  return candidates
    .map((c) => {
      const eligible = (c.dimension === "recognition" || c.dimension === "correction") && c.bankRole !== "heldout";
      const bonus = eligible ? (bonusBySkill[c.skillId] ?? 0) : 0;
      return { skillId: c.skillId, pSelect: c.basePriority * c.planMultiplier + bonus, bonus };
    })
    .sort((x, y) => y.pSelect - x.pSelect || (x.skillId < y.skillId ? -1 : x.skillId > y.skillId ? 1 : 0));
}

/** Per-session cap on discovery probes: min(2, floor(.15 N), exploration slots); at most one per suspected skill. */
export function discoveryProbeLimit(taskCount: number, explorationSlots: number, cfg: DiscoveryConfig = DISCOVERY_V1): number {
  return Math.max(0, Math.min(cfg.maxProbesAbsolute, Math.floor(cfg.maxProbesFraction * taskCount), explorationSlots));
}
