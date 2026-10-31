import { clampMultiplier, selectSession, scaleQuotas, discoveryProbeLimit, type Candidate } from "@english-lab/learning";
import { difficultyLevels, voiceTaskCount, type ShortageDetails } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { loadBlockedFingerprints, loadCandidates } from "./bank.js";
import { loadBlueprint, loadPlan, loadSettings, type SessionDeps } from "./policy.js";

export interface Readiness {
  /** disjoint snapshots that can still be built one after another from the current bank */
  readySessions: number;
  /** why the next one cannot be built (null while the cap of 50 simulated sessions was reached) */
  shortage: ShortageDetails | null;
}

const SIMULATION_CAP = 50;

/**
 * Sequential simulation on a COPY of the eligibility state: each simulated snapshot reserves its sentences before the next one is
 * tried, so the count is the number of non-overlapping sessions - not "how many blueprints look feasible on their own". Nothing
 * is written: no reservation, no exposure, no decision.
 */
export function computeReadiness(db: Db, deps: SessionDeps, blueprintRevisionId: string): Readiness {
  const blueprint = loadBlueprint(db, blueprintRevisionId);
  const settings = loadSettings(db);
  const plan = loadPlan(db, deps);
  const candidates = loadCandidates(db, "practice", blueprint.policy.skillPool, difficultyLevels(settings.values));
  const blocked = loadBlockedFingerprints(db);
  const n = settings.values.taskCount;
  const quotas = scaleQuotas(blueprint.policy.quotas, n);
  const byId = new Map<string, Candidate>(candidates.map((c) => [c.revisionId, c]));
  const exploreSlots = n - Math.round(n * settings.values.weakRatio);
  let ready = 0;
  for (; ready < SIMULATION_CAP; ready++) {
    const r = selectSession({
      n,
      weakRatio: settings.values.weakRatio,
      voiceTarget: voiceTaskCount(settings.values),
      seed: `readiness-${ready}`,
      quotas,
      readingBlocks: blueprint.policy.readingBlocks,
      candidates,
      blocked,
      priority: () => 0.5,
      planMultiplier: (s) => clampMultiplier(plan.multipliers[s]),
      discovery: { bonusBySkill: {}, limit: discoveryProbeLimit(n, exploreSlots) },
      maxNodes: 5000,
    });
    if (!r.feasible) {
      return { readySessions: ready, shortage: { deficits: r.deficits, largestFeasibleN: r.largestFeasibleN, requestedN: n } };
    }
    for (const s of r.slots) for (const f of byId.get(s.revisionId)!.unitFingerprints) blocked.add(f);
  }
  return { readySessions: ready, shortage: null };
}
