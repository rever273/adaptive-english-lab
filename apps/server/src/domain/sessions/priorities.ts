import { MASTERY_V1, computePriority, diagnosticPrior, type Dimension } from "@english-lab/learning";
import type { Db } from "../../db/open.js";
import { currentWatermark, loadActivity, loadDiagnosticOutcomes, loadEvidence } from "../analytics/evidence.js";
import { computeGroups } from "../analytics/runs.js";
import type { BankCandidate } from "./bank.js";

const DAY = 86_400_000;

export interface PriorityTable {
  /** base priority P for (skill, dimension, cohort); unknown pairs get the never-practised default */
  lookup: (skill: string, dimension: Dimension, cohort: string) => number;
  /** deterministic fingerprint of the evidence that produced the table (goes into candidate_hash) */
  evidenceHash: string;
  watermark: number;
}

/**
 * P = .4 weakness + .25 failure pressure + .2 due + .15 uncertainty (spec/04), computed from the same eligible evidence
 * as Mastery. Pure arithmetic from stored events: no model, and a larger bank never changes a skill's priority.
 */
export function loadPriorities(db: Db, candidates: readonly BankCandidate[], asOfIso: string, taxonomyId: string, additionalCohorts: readonly { criterionVersion: string; difficulty: string }[] = []): PriorityTable {
  const watermark = currentWatermark(db);
  const cohorts = new Map<string, { criterionVersion: string; difficulty: BankCandidate["difficulty"] }>();
  for (const c of candidates) cohorts.set(`${c.rubricVersion}|${c.difficulty}`, { criterionVersion: c.rubricVersion, difficulty: c.difficulty });
  for (const c of additionalCohorts) cohorts.set(`${c.criterionVersion}|${c.difficulty}`, c);
  const table = new Map<string, number>();
  const parts: string[] = [];
  for (const [key, cohort] of [...cohorts.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const evidence = loadEvidence(db, { watermark, asOf: asOfIso, taxonomyId, cohort: cohort as { criterionVersion: string; difficulty: "A2" | "B1" | "B2" | "C1" | "C2" } });
    const activity = loadActivity(db, { watermark, asOf: asOfIso, taxonomyId });
    const groups = computeGroups(evidence, activity, asOfIso, MASTERY_V1);
    const bySkillDim = new Map<string, typeof evidence>();
    for (const e of evidence) (bySkillDim.get(`${e.skillId}|${e.dimension}`) ?? bySkillDim.set(`${e.skillId}|${e.dimension}`, []).get(`${e.skillId}|${e.dimension}`)!).push(e);
    for (const g of groups) {
      const rows = bySkillDim.get(`${g.skillId}|${g.dimension}`) ?? [];
      const last20 = rows.slice(-20);
      const c = g.components;
      const p = computePriority({
        score: c.score,
        reliable: c.status === "developing" || c.status === "stable" || c.status === "stale",
        nEff: c.nEff,
        failuresLast20: last20.filter((r) => !r.success).length,
        daysSinceLastIndependent: c.lastSeen === null ? null : Math.max(0, (Date.parse(asOfIso) - Date.parse(c.lastSeen)) / DAY),
      });
      table.set(`${g.skillId}|${g.dimension}|${key}`, p.p);
      parts.push(`${g.skillId}|${g.dimension}|${key}|${c.n}|${c.score}`);
    }
  }
  const unknown = computePriority({ score: null, reliable: false, nEff: null, failuresLast20: 0, daysSinceLastIndependent: null }).p;
  // a skill without practice evidence starts from what the starting diagnostic showed (selection prior only, D62)
  const diagnostic = loadDiagnosticOutcomes(db, { watermark, asOf: asOfIso, taxonomyId });
  for (const [skill, o] of [...diagnostic.entries()]) parts.push(`diag|${skill}|${o.attempts}|${o.failures}`);
  return {
    lookup: (skill, dimension, cohort) => table.get(`${skill}|${dimension}|${cohort}`) ?? diagnosticPrior(unknown, diagnostic.get(skill)),
    evidenceHash: parts.sort().join(";"),
    watermark,
  };
}
