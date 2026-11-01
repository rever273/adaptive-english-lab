/**
 * selection-v1: seeded, constrained allocation of one session snapshot (spec/04 pseudocode, LESSON_BLUEPRINTS policy).
 * Pure and deterministic: same input + same seed = same output. No I/O, no clock, no model.
 *
 * Hard rules (never relaxed): exactly N slots, valid target format, no sentence that was already shown or is reserved,
 * one candidate per exercise, distinct template cluster, at most ceil(.35 N) per family and ceil(.40 N) per format,
 * >= 3 families and >= 3 formats when N >= 10, a No-mistake case when detect_error has >= 4 slots.
 * When they cannot all hold the result is `feasible: false` with deficits and a *suggested* smaller N - never a silent relaxation.
 */

import type { Dimension } from "./mastery.js";

export const SELECTION_VERSION = "selection-v1";
/**
 * D68: grammar practice may bring back a labelled repeat. The solver itself is unchanged for fresh candidates (and keeps the
 * `selection-v1` seed prefix, so a bank without repeats gives the same sessions); only the recorded algorithm id is new.
 */
export const GRAMMAR_SELECTION_V2 = "grammar-selection-v2";
export const GRAMMAR_SELECTION_V3 = "grammar-selection-v3";
export const GRAMMAR_SELECTION_V4 = "grammar-selection-v4";

/** repeat limits of grammar-selection-v3 (stored in algorithm_versions) */
export const GRAMMAR_REPEAT_CONFIG = {
  /** missed / assisted / skipped exercises return from the next session on; they may take at most this share of the slots */
  soonShare: 0.3,
  /** all repeats together never take more than this share */
  totalShare: 0.6,
  /** an exercise answered correctly (unaided) normally returns after this many days */
  correctAfterDays: 3,
  /** correct answers may return sooner only if the normal pool cannot fill a session */
  shortageAfterDays: 1,
} as const;

export type Format = "choose_form" | "choose_missing_fragment" | "detect_error" | "guided_short_answer" | "russian_to_english_short" | "context_reading";
export type NonReadingFormat = Exclude<Format, "context_reading">;

export const FORMAT_ORDER: readonly NonReadingFormat[] = ["choose_form", "detect_error", "choose_missing_fragment", "guided_short_answer", "russian_to_english_short"];

/** First-run default for N = 18 (D19): 5/5/5/1/2; production = 3. */
export const DEFAULT_QUOTAS: Record<NonReadingFormat, number> = {
  choose_form: 5,
  choose_missing_fragment: 5,
  detect_error: 5,
  guided_short_answer: 1,
  russian_to_english_short: 2,
};

export interface Candidate {
  revisionId: string;
  exerciseId: string;
  format: Format;
  dimension: Dimension;
  skillId: string;
  family: string;
  contextId: string;
  templateCluster: string;
  bankRole: "practice" | "diagnostic" | "heldout";
  /** mastery cohort of the revision (criterion version + difficulty): priorities are looked up per cohort, never mixed */
  cohort?: string;
  /** detect_error "No mistake" case */
  noMistake: boolean;
  /** question slots of a reading passage (2-3); 1 for every other format */
  childCount: number;
  /** all sentence-unit fingerprints the revision would reserve (prompt, passage, options, accepted answers) */
  unitFingerprints: readonly string[];
  /**
   * D68: this exercise was shown before (an ended grammar practice session) and is due again. `unitFingerprints` then lists only the
   * units never exposed (the ledger already holds the rest). "missed" / "assisted" return soon, "review" (a correct answer) rarely.
   */
  repeat?: { reason: "missed" | "assisted" | "review"; ofSlotId: string };
}

export interface SelectionInput {
  n: number;
  weakRatio: number;
  voiceTarget: number;
  seed: string;
  /** per-format counts for non-reading slots; a reading block replaces recognition slots (see `readingBlocks`) */
  quotas: Readonly<Record<NonReadingFormat, number>>;
  /** 0 or 1 reading passage replacing choose_form/fragment slots (L03/L06/L10) */
  readingBlocks: 0 | 1;
  candidates: readonly Candidate[];
  /** fingerprints that were shown (global) or are reserved by another snapshot */
  blocked: ReadonlySet<string>;
  /** P for (skill, dimension), before the plan multiplier */
  priority: (skillId: string, dimension: Dimension, cohort: string) => number;
  planMultiplier: (skillId: string) => number;
  /** discovery-v1 bonus per suspected skill (already capped) and how many probes may be used */
  discovery: { bonusBySkill: Readonly<Record<string, number>>; limit: number };
  /** search budget: nodes explored before the solver gives up on a feasible answer */
  maxNodes?: number;
  /** Optional cost for stock planning; normal session selection does not use this. */
  candidatePenalty?: (candidate: Candidate) => number;
}

export type SlotRole = "weak" | "explore" | "discovery";

export interface SelectedSlot {
  ordinal: number;
  revisionId: string;
  exerciseId: string;
  format: Format;
  dimension: Dimension;
  skillId: string;
  family: string;
  role: SlotRole;
  priority: number;
  multiplier: number;
  bonus: number;
  readingGroupId: string | null;
  /** 0-based index among the children of a reading passage */
  childIndex: number | null;
  inputPreference: "text" | "voice";
  /** D68: set when the slot is a labelled repeat */
  repeat?: { reason: "missed" | "assisted" | "review"; ofSlotId: string };
}

export interface Deficit {
  kind: "format" | "family_cap" | "no_mistake" | "diversity" | "reading" | "search_budget" | "repeat_cap";
  format?: Format;
  needed?: number;
  available?: number;
  message: string;
}

export interface SelectionResult {
  feasible: boolean;
  slots: SelectedSlot[];
  deficits: Deficit[];
  /** suggestion only (never applied silently): the largest N for which the same bank is feasible */
  largestFeasibleN: number | null;
  stats: { nodes: number; weakTarget: number; weakActual: number; discoveryTarget: number; discoveryActual: number; voiceActual: number; families: number; formats: number };
}

// ---------- helpers ----------

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, deterministic, well-distributed. */
function rng(seed: string): () => number {
  let a = fnv1a(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const familyCap = (n: number): number => Math.ceil(0.35 * n);
export const formatCap = (n: number): number => Math.ceil(0.4 * n);

/** Largest-remainder scaling of the default quota shape to N slots (Settings allow 5-30). */
export function scaleQuotas(base: Readonly<Record<NonReadingFormat, number>>, n: number): Record<NonReadingFormat, number> {
  const total = FORMAT_ORDER.reduce((s, f) => s + base[f], 0);
  if (total === n) return { ...base };
  const raw = FORMAT_ORDER.map((f) => ({ f, exact: (base[f] * n) / total }));
  const out = Object.fromEntries(raw.map((r) => [r.f, Math.floor(r.exact)])) as Record<NonReadingFormat, number>;
  let left = n - FORMAT_ORDER.reduce((s, f) => s + out[f], 0);
  for (const r of [...raw].sort((a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)) || FORMAT_ORDER.indexOf(a.f) - FORMAT_ORDER.indexOf(b.f))) {
    if (left-- <= 0) break;
    out[r.f] += 1;
  }
  return out;
}

/** A reading block of k questions replaces k recognition slots: 2/3 from choose_form (rounded up), the rest from fragments. */
export function applyReading(quotas: Readonly<Record<NonReadingFormat, number>>, k: number): Record<NonReadingFormat, number> {
  const out = { ...quotas };
  let remaining = k;
  const take = (f: NonReadingFormat, m: number) => {
    const t = Math.min(out[f], m, remaining);
    out[f] -= t;
    remaining -= t;
  };
  take("choose_form", Math.round((2 * k) / 3));
  take("choose_missing_fragment", remaining);
  take("choose_form", remaining);
  return out;
}

interface Spec {
  format: NonReadingFormat;
  role: SlotRole;
  /** the suspected skill a discovery slot must probe */
  skill?: string;
}

// ---------- the solver ----------

export function selectSession(input: SelectionInput): SelectionResult {
  const first = solve(input);
  if (first.feasible || input.n <= 5) return first;
  // suggestion only: scan downwards for the largest feasible N on the same bank
  for (let n = input.n - 1; n >= 5; n--) {
    const attempt = solve({ ...input, n, quotas: scaleQuotas(input.quotas, n), maxNodes: Math.min(input.maxNodes ?? 20000, 5000) });
    if (attempt.feasible) return { ...first, largestFeasibleN: n };
  }
  return first;
}

function solve(input: SelectionInput): SelectionResult {
  const { n } = input;
  const rand = rng(`${SELECTION_VERSION}|${input.seed}|${n}`);
  const budget = input.maxNodes ?? 100000;
  const deficits: Deficit[] = [];
  const empty = (): SelectionResult => ({
    feasible: false,
    slots: [],
    deficits,
    largestFeasibleN: null,
    stats: { nodes: 0, weakTarget: 0, weakActual: 0, discoveryTarget: 0, discoveryActual: 0, voiceActual: 0, families: 0, formats: 0 },
  });

  // 1. candidate pool: nothing that repeats a shown/reserved sentence; stable order
  const pool = input.candidates
    .filter((c) => c.bankRole !== "heldout" && !c.unitFingerprints.some((f) => input.blocked.has(f)))
    .slice()
    .sort((a, b) => (a.revisionId < b.revisionId ? -1 : 1));

  const repeatSoonCap = Math.floor(GRAMMAR_REPEAT_CONFIG.soonShare * n);
  const repeatTotalCap = Math.floor(GRAMMAR_REPEAT_CONFIG.totalShare * n);

  // 2. reading block first: it fixes which recognition slots disappear
  let quotas: Record<NonReadingFormat, number> = { ...input.quotas };
  let reading: Candidate | null = null;
  if (input.readingBlocks > 0) {
    const options = pool.filter((c) => c.format === "context_reading");
    if (options.length === 0) {
      deficits.push({ kind: "reading", format: "context_reading", needed: 1, available: 0, message: "This lesson needs a reading passage and none is available" });
      return { ...empty(), deficits };
    }
    const freshOptions = options.filter((c) => !c.repeat); // fresh first: a repeated passage only when no new one is left
    // a repeated passage uses its questions from the repeat budget, so it is offered only when it fits the caps
    const fits = (c: Candidate) => c.childCount <= repeatTotalCap && (c.repeat?.reason === "review" || c.childCount <= repeatSoonCap);
    const readingFrom = freshOptions.length > 0 ? freshOptions : options.filter(fits);
    if (readingFrom.length === 0) {
      deficits.push({ kind: "reading", format: "context_reading", needed: 1, available: 0, message: "This lesson needs a reading passage: no new one is left and a repeated passage would exceed the repeat limits" });
      return { ...empty(), deficits };
    }
    reading = readingFrom[Math.floor(rand() * readingFrom.length)]!;
    quotas = applyReading(quotas, reading.childCount);
  }
  const readingSlots = reading ? reading.childCount : 0;
  const slotCount = FORMAT_ORDER.reduce((s, f) => s + quotas[f], 0);
  if (slotCount + readingSlots !== n) {
    deficits.push({ kind: "diversity", message: `Quotas give ${slotCount + readingSlots} slots, not ${n}` });
    return { ...empty(), deficits };
  }

  // 3. availability per format (distinct exercises) - the first, most honest deficit
  for (const f of FORMAT_ORDER) {
    const available = new Set(pool.filter((c) => c.format === f).map((c) => c.exerciseId)).size;
    if (available < quotas[f]) deficits.push({ kind: "format", format: f, needed: quotas[f], available, message: `Not enough approved ${f} exercises: ${available} of ${quotas[f]} available` });
  }
  if (deficits.length === 0) {
    // the repeat limits can be the binding constraint even when every format has enough exercises in total
    const readingSoon = reading?.repeat && reading.repeat.reason !== "review" ? reading.childCount : 0;
    const readingAll = reading?.repeat ? reading.childCount : 0;
    let needAll = 0;
    let needSoon = 0;
    for (const f of FORMAT_ORDER) {
      const fresh = new Set(pool.filter((c) => c.format === f && !c.repeat).map((c) => c.exerciseId)).size;
      const review = new Set(pool.filter((c) => c.format === f && c.repeat?.reason === "review").map((c) => c.exerciseId)).size;
      const need = Math.max(0, quotas[f] - fresh);
      needAll += need;
      needSoon += Math.max(0, need - review);
    }
    const over = Math.max(needAll - (repeatTotalCap - readingAll), needSoon - (repeatSoonCap - readingSoon));
    if (over > 0) {
      deficits.push({ kind: "repeat_cap", needed: needAll, available: Math.max(0, repeatTotalCap - readingAll), message: `Only ${Math.max(0, repeatTotalCap - readingAll)} repeated exercise(s) can be used per session; ${over} more NEW exercise(s) are needed` });
    }
  }
  if (quotas.detect_error >= 4 && !pool.some((c) => c.format === "detect_error" && c.noMistake)) {
    deficits.push({ kind: "no_mistake", format: "detect_error", needed: 1, available: 0, message: "No approved \"No mistake\" case is available for detect_error" });
  }
  if (deficits.length > 0) return { ...empty(), deficits };

  // 4. roles: weak share by largest remainder across formats, discovery probes carved out of explore slots
  const weakTarget = Math.min(Math.round(n * input.weakRatio), slotCount);
  const byFormatWeak = allocateWeak(quotas, weakTarget);
  const specs: Spec[] = [];
  for (const f of FORMAT_ORDER) for (let i = 0; i < quotas[f]; i++) specs.push({ format: f, role: i < byFormatWeak[f] ? "weak" : "explore" });

  // discovery probes: top suspected skills with a bonus that have an eligible recognition/correction candidate
  const discoverySkills = Object.entries(input.discovery.bonusBySkill)
    .filter(([, b]) => b > 0)
    .map(([skillId, bonus]) => ({ skillId, bonus }))
    .filter((d) => pool.some((c) => c.skillId === d.skillId && (c.dimension === "recognition" || c.dimension === "correction") && c.format !== "context_reading"))
    .sort((a, b) => b.bonus - a.bonus || (a.skillId < b.skillId ? -1 : 1));
  // a probe goes into an exploration slot whose FORMAT can actually carry an unseen exercise of the suspected skill
  const assigned = new Set<Spec>();
  let discoveryTarget = 0;
  for (const d of discoverySkills) {
    if (discoveryTarget >= input.discovery.limit) break;
    const formats = new Set(pool.filter((c) => c.skillId === d.skillId && (c.dimension === "recognition" || c.dimension === "correction") && c.format !== "context_reading").map((c) => c.format));
    const spec = specs.find((sp) => sp.role === "explore" && !assigned.has(sp) && formats.has(sp.format));
    if (!spec) continue;
    spec.role = "discovery";
    spec.skill = d.skillId;
    assigned.add(spec);
    discoveryTarget++;
  }

  // 5. depth-first search with a node budget; most constrained slots first
  const mult = (skill: string) => input.planMultiplier(skill);
  const order = specs
    .map((s, idx) => ({ s, idx, supply: new Set(pool.filter((c) => c.format === s.format).map((c) => c.exerciseId)).size }))
    .sort((a, b) => (a.s.role === "discovery" ? 0 : 1) - (b.s.role === "discovery" ? 0 : 1) || a.supply - b.supply || a.idx - b.idx);

  const chosen: Array<{ spec: Spec; cand: Candidate; score: number; bonus: number }> = [];
  const usedFp = new Set<string>(reading ? reading.unitFingerprints : []);
  const usedExercise = new Set<string>(reading ? [reading.exerciseId] : []);
  const usedCluster = new Set<string>(reading ? [reading.templateCluster] : []);
  const familyCount = new Map<string, number>(reading ? [[reading.family, reading.childCount]] : []);
  const usedSkill = new Set<string>(reading ? [reading.skillId] : []);
  const usedContext = new Set<string>(reading ? [reading.contextId] : []);
  const discoveryUsed = new Set<string>();
  let nodes = 0;
  let needNoMistake = quotas.detect_error >= 4;
  const jitter = new Map<string, number>(pool.map((c) => [c.revisionId, rand()]));
  const cap = familyCap(n);
  // D68 repeat budget: missed/assisted repeats up to soonShare, all repeats up to totalShare (a repeated passage counts all its questions)
  const soonCap = repeatSoonCap;
  const totalCap = repeatTotalCap;
  let soonUsed = reading?.repeat && reading.repeat.reason !== "review" ? reading.childCount : 0;
  let repeatUsed = reading?.repeat ? reading.childCount : 0;

  const score = (spec: Spec, c: Candidate): { score: number; bonus: number } => {
    const p = input.priority(c.skillId, c.dimension, c.cohort ?? "") * mult(c.skillId);
    const j = (jitter.get(c.revisionId) ?? 0) * 1e-6;
    // fresh first: a repeat after a correct answer is the last choice, so it fills a slot only when nothing else can
    if (c.repeat?.reason === "review") return { score: -1000 + p + j, bonus: 0 };
    const penalty = input.candidatePenalty?.(c) ?? 0;
    if (spec.role === "weak") return { score: p + j - penalty, bonus: 0 };
    if (spec.role === "discovery") {
      const bonus = input.discovery.bonusBySkill[c.skillId] ?? 0; // bonus is not multiplied by the agent multiplier
      return { score: p + bonus + j - penalty, bonus };
    }
    // explore: new skill/family/context first, then the base priority as a mild tie-breaker
    const nov = (usedSkill.has(c.skillId) ? 0 : 1) + (familyCount.has(c.family) ? 0 : 0.5) + (usedContext.has(c.contextId) ? 0 : 0.1);
    return { score: nov + 0.3 * p + (jitter.get(c.revisionId) ?? 0) * 0.05 - penalty, bonus: 0 };
  };

  const allowed = (spec: Spec, c: Candidate): boolean => {
    if (c.format !== spec.format) return false;
    if (usedExercise.has(c.exerciseId) || usedCluster.has(c.templateCluster)) return false;
    if ((familyCount.get(c.family) ?? 0) + 1 > cap) return false;
    if (c.unitFingerprints.some((f) => usedFp.has(f))) return false;
    if (c.repeat) {
      if (spec.role === "discovery") return false; // a probe must be a new look at the suspected skill
      if (repeatUsed + 1 > totalCap) return false;
      if (c.repeat.reason !== "review" && soonUsed + 1 > soonCap) return false;
    }
    if (spec.role === "discovery") {
      if (c.skillId !== spec.skill) return false;
      if (!(c.dimension === "recognition" || c.dimension === "correction")) return false;
      if ((input.discovery.bonusBySkill[c.skillId] ?? 0) <= 0 || discoveryUsed.has(c.skillId)) return false;
    }
    return true;
  };

  const finalOk = (): boolean => {
    if (n < 10) return true;
    const families = new Set(chosen.map((x) => x.cand.family));
    const formats = new Set(chosen.map((x) => x.cand.format));
    if (reading) {
      families.add(reading.family);
      formats.add("context_reading");
    }
    return families.size >= 3 && formats.size >= 3;
  };

  const dfs = (k: number): boolean => {
    if (nodes++ > budget) return false;
    if (k === order.length) return finalOk() && !needNoMistake;
    const { s: spec } = order[k]!;
    const options = pool
      .filter((c) => allowed(spec, c))
      .map((c) => ({ c, ...score(spec, c) }))
      .sort((a, b) => b.score - a.score || (a.c.revisionId < b.c.revisionId ? -1 : 1));
    // the No-mistake requirement is satisfied by the first detect_error slot that can take such a case
    const forceNoMistake = spec.format === "detect_error" && needNoMistake && spec.role !== "discovery"; // a probe may be an error item; another slot supplies the No-mistake case
    const eligible = forceNoMistake ? options.filter((o) => o.c.noMistake) : options;
    const tries = eligible;
    for (const o of tries) {
      chosen.push({ spec, cand: o.c, score: o.score, bonus: o.bonus });
      if (o.c.repeat) {
        repeatUsed++;
        if (o.c.repeat.reason !== "review") soonUsed++;
      }
      for (const f of o.c.unitFingerprints) usedFp.add(f);
      usedExercise.add(o.c.exerciseId);
      usedCluster.add(o.c.templateCluster);
      familyCount.set(o.c.family, (familyCount.get(o.c.family) ?? 0) + 1);
      const hadSkill = usedSkill.has(o.c.skillId);
      const hadContext = usedContext.has(o.c.contextId);
      usedSkill.add(o.c.skillId);
      usedContext.add(o.c.contextId);
      if (spec.role === "discovery") discoveryUsed.add(o.c.skillId);
      const hadNoMistake = needNoMistake;
      if (o.c.noMistake && spec.format === "detect_error") needNoMistake = false;

      if (dfs(k + 1)) return true;

      needNoMistake = hadNoMistake;
      if (spec.role === "discovery") discoveryUsed.delete(o.c.skillId);
      if (o.c.repeat) {
        repeatUsed--;
        if (o.c.repeat.reason !== "review") soonUsed--;
      }
      if (!hadContext) usedContext.delete(o.c.contextId);
      if (!hadSkill) usedSkill.delete(o.c.skillId);
      familyCount.set(o.c.family, (familyCount.get(o.c.family) ?? 1) - 1);
      usedCluster.delete(o.c.templateCluster);
      usedExercise.delete(o.c.exerciseId);
      for (const f of o.c.unitFingerprints) usedFp.delete(f);
      chosen.pop();
      if (nodes > budget) return false;
    }
    return false;
  };

  if (!dfs(0)) {
    const message = nodes > budget ? "Search budget exhausted before a session satisfying every hard rule was found" : "No combination of approved exercises satisfies every hard rule (family / format caps, diversity, no repeated sentence)";
    deficits.push({ kind: nodes > budget ? "search_budget" : "family_cap", message });
    return { ...empty(), deficits, stats: { ...empty().stats, nodes, weakTarget } };
  }

  // 6. final order: formats interleaved in rotation, reading passage contiguous in the middle
  const queues = new Map<NonReadingFormat, typeof chosen>(FORMAT_ORDER.map((f) => [f, chosen.filter((x) => x.spec.format === f).sort((a, b) => (a.cand.revisionId < b.cand.revisionId ? -1 : 1))]));
  const sequence: typeof chosen = [];
  while (sequence.length < chosen.length) {
    for (const f of FORMAT_ORDER) {
      const next = queues.get(f)!.shift();
      if (next) sequence.push(next);
    }
  }
  const slots: SelectedSlot[] = [];
  const pushSlot = (x: (typeof chosen)[number] | null, readingChild: number | null) => {
    if (x === null && reading === null) return;
    const c = x ? x.cand : reading!;
    slots.push({
      ordinal: slots.length,
      revisionId: c.revisionId,
      exerciseId: c.exerciseId,
      format: c.format,
      dimension: c.dimension,
      skillId: c.skillId,
      family: c.family,
      role: x ? x.spec.role : "explore",
      priority: input.priority(c.skillId, c.dimension, c.cohort ?? ""),
      multiplier: mult(c.skillId),
      bonus: x ? x.bonus : 0,
      readingGroupId: readingChild === null ? null : `reading:${reading!.revisionId}`,
      childIndex: readingChild,
      inputPreference: "text",
      ...(c.repeat ? { repeat: c.repeat } : {}),
    });
  };
  const readingAt = reading ? Math.floor(sequence.length / 2) : -1;
  sequence.forEach((x, i) => {
    if (i === readingAt && reading) for (let k = 0; k < reading.childCount; k++) pushSlot(null, k);
    pushSlot(x, null);
  });
  if (reading && readingAt >= sequence.length) for (let k = 0; k < reading.childCount; k++) pushSlot(null, k);

  // voice preference: the first production slots, up to voiceTarget (text/skip always available)
  let voice = 0;
  for (const s of slots) {
    if (s.dimension === "production" && voice < input.voiceTarget) {
      s.inputPreference = "voice";
      voice++;
    }
  }
  const families = new Set(slots.map((s) => s.family));
  const formats = new Set(slots.map((s) => s.format));
  return {
    feasible: true,
    slots,
    deficits: [],
    largestFeasibleN: n,
    stats: {
      nodes,
      weakTarget,
      weakActual: chosen.filter((x) => x.spec.role === "weak").length,
      discoveryTarget,
      discoveryActual: chosen.filter((x) => x.spec.role === "discovery").length,
      voiceActual: voice,
      families: families.size,
      formats: formats.size,
    },
  };
}

function allocateWeak(quotas: Readonly<Record<NonReadingFormat, number>>, weakTarget: number): Record<NonReadingFormat, number> {
  const total = FORMAT_ORDER.reduce((s, f) => s + quotas[f], 0);
  const out = Object.fromEntries(FORMAT_ORDER.map((f) => [f, 0])) as Record<NonReadingFormat, number>;
  if (total === 0) return out;
  const rows = FORMAT_ORDER.map((f) => ({ f, exact: (quotas[f] * weakTarget) / total }));
  for (const r of rows) out[r.f] = Math.min(quotas[r.f], Math.floor(r.exact));
  let left = weakTarget - FORMAT_ORDER.reduce((s, f) => s + out[f], 0);
  for (const r of [...rows].sort((a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)) || FORMAT_ORDER.indexOf(a.f) - FORMAT_ORDER.indexOf(b.f))) {
    if (left <= 0) break;
    if (out[r.f] < quotas[r.f]) {
      out[r.f] += 1;
      left--;
    }
  }
  return out;
}

/** Independent check of the hard rules on a finished selection; used by tests and by the server before commit. */
export function hardViolations(slots: readonly SelectedSlot[], n: number, candidates: ReadonlyMap<string, Candidate>, blocked: ReadonlySet<string>, quotas?: Readonly<Record<NonReadingFormat, number>>): string[] {
  const v: string[] = [];
  if (slots.length !== n) v.push(`slot count ${slots.length} != ${n}`);
  const families = new Map<string, number>();
  const formats = new Map<string, number>();
  const fp = new Set<string>();
  const exercises = new Set<string>();
  const clusters = new Set<string>();
  const seenRevisionForGroup = new Set<string>();
  for (const s of slots) {
    const c = candidates.get(s.revisionId);
    if (!c) {
      v.push(`unknown candidate ${s.revisionId}`);
      continue;
    }
    families.set(c.family, (families.get(c.family) ?? 0) + 1);
    formats.set(c.format, (formats.get(c.format) ?? 0) + 1);
    if (c.bankRole === "heldout") v.push("held-out candidate in a practice session");
    if (s.readingGroupId && seenRevisionForGroup.has(s.revisionId)) continue; // children of one passage share their revision
    if (s.readingGroupId) seenRevisionForGroup.add(s.revisionId);
    if (exercises.has(c.exerciseId)) v.push(`exercise ${c.exerciseId} twice`);
    exercises.add(c.exerciseId);
    if (clusters.has(c.templateCluster)) v.push(`template cluster ${c.templateCluster} twice`);
    clusters.add(c.templateCluster);
    for (const f of c.unitFingerprints) {
      if (blocked.has(f)) v.push("shown or reserved sentence");
      if (fp.has(f)) v.push("sentence twice in one session");
      fp.add(f);
    }
  }
  for (const [f, k] of families) if (k > familyCap(n)) v.push(`family ${f} has ${k} > ${familyCap(n)}`);
  for (const [f, k] of formats) if (k > formatCap(n)) v.push(`format ${f} has ${k} > ${formatCap(n)}`);
  if (n >= 10 && families.size < 3) v.push("fewer than 3 families");
  if (n >= 10 && formats.size < 3) v.push("fewer than 3 formats");
  const detect = slots.filter((s) => s.format === "detect_error");
  if (detect.length >= 4 && !detect.some((s) => candidates.get(s.revisionId)?.noMistake)) v.push("no No-mistake case");
  const repeats = slots.filter((s) => s.repeat);
  if (repeats.length > Math.floor(GRAMMAR_REPEAT_CONFIG.totalShare * n)) v.push(`repeats ${repeats.length} above the cap`);
  if (repeats.filter((s) => s.repeat!.reason !== "review").length > Math.floor(GRAMMAR_REPEAT_CONFIG.soonShare * n)) v.push("missed/assisted repeats above the cap");
  if (quotas) for (const f of FORMAT_ORDER) if (slots.filter((s) => s.format === f).length > quotas[f]) v.push(`format ${f} above quota`);
  return v;
}
