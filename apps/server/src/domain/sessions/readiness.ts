import { clampMultiplier, selectSession, scaleQuotas, discoveryProbeLimit, type Candidate } from "@english-lab/learning";
import { difficultyLevels, voiceTaskCount, type ShortageDetails } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { loadBlockedFingerprints, loadCandidates } from "./bank.js";
import { withRepeats } from "./repeats.js";
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
const CACHE_TTL_MS = 60_000;
const readinessCache = new WeakMap<Db, { signature: string; at: number; byLesson: Map<string, Readiness> }>();
// Tables whose change can alter what a lesson can be built from; counts are enough because they are append-only (sessions also change status).
const SIGNATURE_TABLES = ["content_state_events", "release_items", "exposures", "session_slots", "prompt_reservations", "settings_revisions", "learning_plans", "blueprint_revisions", "attempts", "assessment_revisions"];
function dataSignature(db: Db): string {
  const parts = SIGNATURE_TABLES.map((t) => `(SELECT COUNT(*) || ':' || COALESCE(MAX(rowid), 0) FROM ${t})`);
  parts.push("(SELECT COUNT(*) || ':' || COALESCE(SUM(status = 'completed'), 0) FROM sessions)");
  return (db.prepare(`SELECT ${parts.join(" || '|' || ")} AS s`).get() as { s: string }).s;
}

/** Cached for a minute and dropped as soon as the underlying data changes, so the dashboard stays fast without going stale. */
export function computeReadiness(db: Db, deps: SessionDeps, blueprintRevisionId: string): Readiness {
  const signature = dataSignature(db);
  let entry = readinessCache.get(db);
  if (!entry || entry.signature !== signature || deps.now().getTime() - entry.at > CACHE_TTL_MS) {
    entry = { signature, at: deps.now().getTime(), byLesson: new Map() };
    readinessCache.set(db, entry);
  }
  let value = entry.byLesson.get(blueprintRevisionId);
  if (!value) { value = simulateReadiness(db, deps, blueprintRevisionId); entry.byLesson.set(blueprintRevisionId, value); }
  return value;
}

function simulateReadiness(db: Db, deps: SessionDeps, blueprintRevisionId: string): Readiness {
  const blueprint = loadBlueprint(db, blueprintRevisionId);
  const settings = loadSettings(db);
  const plan = loadPlan(db, deps);
  // D68: fresh exercises plus the repeats that are due now (the same set createPracticeSession would use)
  const bank = loadCandidates(db, "practice", blueprint.policy.skillPool, difficultyLevels(settings.values));
  let candidates = withRepeats(db, bank, deps.now()).candidates;
  let shortageCandidates = withRepeats(db, bank, deps.now(), "shortage").candidates;
  const blocked = loadBlockedFingerprints(db);
  const n = settings.values.taskCount;
  const quotas = scaleQuotas(blueprint.policy.quotas, n);
  const byId = new Map<string, Candidate>(shortageCandidates.map((c) => [c.revisionId, c]));
  const exploreSlots = n - Math.round(n * settings.values.weakRatio);
  let ready = 0;
  for (; ready < SIMULATION_CAP; ready++) {
    const solve = (pool: Candidate[]) => selectSession({
      n,
      weakRatio: settings.values.weakRatio,
      voiceTarget: voiceTaskCount(settings.values),
      seed: `readiness-${ready}`,
      quotas,
      readingBlocks: blueprint.policy.readingBlocks,
      candidates: pool,
      blocked,
      priority: () => 0.5,
      planMultiplier: (s) => clampMultiplier(plan.multipliers[s]),
      discovery: { bonusBySkill: {}, limit: discoveryProbeLimit(n, exploreSlots) },
      maxNodes: 100000,
    });
    let r = solve(candidates);
    if (!r.feasible) r = solve(shortageCandidates);
    if (!r.feasible) {
      return { readySessions: ready, shortage: { deficits: r.deficits, largestFeasibleN: r.largestFeasibleN, requestedN: n } };
    }
    for (const s of r.slots) for (const f of byId.get(s.revisionId)!.unitFingerprints) blocked.add(f);
    // a repeat keeps no fingerprint to block (its units are already shown), so a simulated exercise is consumed explicitly
    const taken = new Set(r.slots.map((s) => s.revisionId));
    candidates = candidates.filter((c) => !taken.has(c.revisionId));
    shortageCandidates = shortageCandidates.filter((c) => !taken.has(c.revisionId));
  }
  return { readySessions: ready, shortage: null };
}
