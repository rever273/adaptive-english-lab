import { createHash } from "node:crypto";
import type { BankCandidate } from "../sessions/bank.js";

export type Dim = "recognition" | "correction" | "production";
export interface Need {
  recognition: number;
  correction: number;
  production: number;
  /** at least this many "No mistake" sentences among the correction tasks */
  minNoMistake: number;
  /** at most this many: a greedy block must not use up the scarce "No mistake" sentences the later blocks need */
  maxNoMistake?: number;
}
export interface ChosenSlot {
  ordinal: number;
  revisionId: string;
  dimension: Dim;
  format: string;
  skillId: string;
  family: string;
}
export interface Deficit {
  dimension: Dim | "no_mistake";
  needed: number;
  available: number;
}
export type Selection = { feasible: true; slots: ChosenSlot[] } | { feasible: false; deficits: Deficit[] };

/** deterministic [0,1) stream from a string seed (sha256 counter): same seed, same choice */
function rng(seed: string): () => number {
  let i = 0;
  return () => {
    const h = createHash("sha256").update(`${seed}:${i++}`).digest();
    return h.readUInt32BE(0) / 0x1_0000_0000;
  };
}
function shuffled<T>(a: readonly T[], r: () => number): T[] {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface SelectInput {
  candidates: readonly BankCandidate[];
  allowedFormats: Record<Dim, readonly string[]>;
  need: Need;
  /** sentence fingerprints that may not be used again (shown or reserved) */
  blocked: ReadonlySet<string>;
  /** skills already covered by an earlier block / held-out: avoided while alternatives exist */
  avoidSkills: ReadonlySet<string>;
  /** family names in the order coverage should be spread */
  familyOrder: readonly string[];
  seed: string;
  /** whether every task must have a different skill (diagnostic) */
  distinctSkills: boolean;
  maxNodes?: number;
}

const ORDER: Dim[] = ["correction", "recognition", "production"];

/**
 * Picks one block: the exact R/C/P mix, distinct skills, distinct template clusters, no shared or blocked sentences, at least one "No mistake".
 * Backtracking over a seeded, coverage-ordered candidate list (small pools, node-capped). Pure: no database, no clock.
 */
export function selectBlock(input: SelectInput): Selection {
  const r = rng(input.seed);
  const famRank = (f: string) => {
    const i = input.familyOrder.indexOf(f);
    return i < 0 ? input.familyOrder.length : i;
  };
  const usable = input.candidates.filter((c) => !c.unitFingerprints.some((f) => input.blocked.has(f)));
  const pool = (d: Dim): BankCandidate[] => {
    const base = usable.filter((c) => c.dimension === d && input.allowedFormats[d].includes(c.format));
    // fresh skills first, then broad families first, ties shuffled by the seed
    return shuffled(base, r).sort((a, b) => Number(input.avoidSkills.has(a.skillId)) - Number(input.avoidSkills.has(b.skillId)) || famRank(a.family) - famRank(b.family));
  };
  const pools = { recognition: pool("recognition"), correction: pool("correction"), production: pool("production") };
  const deficits: Deficit[] = [];
  for (const d of ORDER) {
    const avail = input.distinctSkills ? new Set(pools[d].map((c) => c.skillId)).size : pools[d].length;
    if (avail < input.need[d]) deficits.push({ dimension: d, needed: input.need[d], available: avail });
  }
  const noMistakeAvail = pools.correction.filter((c) => c.noMistake).length;
  if (noMistakeAvail < input.need.minNoMistake) deficits.push({ dimension: "no_mistake", needed: input.need.minNoMistake, available: noMistakeAvail });
  if (deficits.length > 0) return { feasible: false, deficits };

  // the work list: the "No mistake" correction task(s) first (the scarcest), then the rest of correction, recognition, production
  type Step = { dim: Dim; mustNoMistake: boolean };
  const steps: Step[] = [];
  for (let i = 0; i < input.need.minNoMistake; i++) steps.push({ dim: "correction", mustNoMistake: true });
  for (let i = input.need.minNoMistake; i < input.need.correction; i++) steps.push({ dim: "correction", mustNoMistake: false });
  for (let i = 0; i < input.need.recognition; i++) steps.push({ dim: "recognition", mustNoMistake: false });
  for (let i = 0; i < input.need.production; i++) steps.push({ dim: "production", mustNoMistake: false });

  const picked: BankCandidate[] = [];
  let noMistakeUsed = 0;
  const skills = new Set<string>();
  const clusters = new Set<string>();
  const units = new Set<string>();
  let nodes = 0;
  const cap = input.maxNodes ?? 50_000;
  const fits = (c: BankCandidate): boolean =>
    !picked.includes(c) && (!input.distinctSkills || !skills.has(c.skillId)) && !clusters.has(c.templateCluster) && !c.unitFingerprints.some((f) => units.has(f));

  const solve = (k: number): boolean => {
    if (k === steps.length) return true;
    if (++nodes > cap) return false;
    const s = steps[k]!;
    for (const c of pools[s.dim]) {
      if (s.mustNoMistake && !c.noMistake) continue;
      if (c.noMistake && input.need.maxNoMistake !== undefined && noMistakeUsed >= input.need.maxNoMistake) continue;
      if (!fits(c)) continue;
      picked.push(c);
      if (c.noMistake) noMistakeUsed++;
      skills.add(c.skillId);
      clusters.add(c.templateCluster);
      c.unitFingerprints.forEach((f) => units.add(f));
      if (solve(k + 1)) return true;
      picked.pop();
      if (c.noMistake) noMistakeUsed--;
      skills.delete(c.skillId);
      clusters.delete(c.templateCluster);
      c.unitFingerprints.forEach((f) => units.delete(f));
    }
    return false;
  };
  if (!solve(0)) {
    return { feasible: false, deficits: [{ dimension: "recognition", needed: input.need.recognition, available: pools.recognition.length }, { dimension: "correction", needed: input.need.correction, available: pools.correction.length }, { dimension: "production", needed: input.need.production, available: pools.production.length }] };
  }
  // presentation order: interleave so that the three kinds are mixed, not three runs of the same kind
  const byDim: Record<Dim, BankCandidate[]> = { recognition: [], correction: [], production: [] };
  for (const c of picked) byDim[c.dimension].push(c);
  const mixed: BankCandidate[] = [];
  const order: Dim[] = ["recognition", "correction", "recognition", "correction", "production", "recognition", "correction", "production"];
  for (const d of order.length >= picked.length ? order : [...order, ...ORDER]) {
    const next = byDim[d].shift();
    if (next) mixed.push(next);
  }
  for (const d of ORDER) mixed.push(...byDim[d]); // anything left (non-standard needs)
  return { feasible: true, slots: mixed.map((c, ordinal) => ({ ordinal, revisionId: c.revisionId, dimension: c.dimension as Dim, format: c.format, skillId: c.skillId, family: c.family })) };
}
