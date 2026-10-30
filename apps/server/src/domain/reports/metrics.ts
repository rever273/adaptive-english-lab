import { MASTERY_V1, markDelayedProbes, wilson95 } from "@english-lab/learning";
import type { RawEvidenceRow } from "../analytics/evidence.js";
import type { AttemptFact, SlotFact } from "./facts.js";

export const REPORT_VERSION = "reports-v1";
export const MIN_COMPARISON_N = 10;
const Z = MASTERY_V1.wilsonZ;
const DAY = 86_400_000;

export interface Ratio {
  numerator: number;
  denominator: number;
  /** null when the denominator is 0: unknown is not zero */
  rate: number | null;
  wilson: { low: number; high: number } | null;
  /** fewer than 10 observations: shown, never interpreted */
  lowN: boolean;
}
export const ratio = (numerator: number, denominator: number): Ratio => ({
  numerator,
  denominator,
  rate: denominator === 0 ? null : numerator / denominator,
  wilson: wilson95(numerator, denominator, Z),
  lowN: denominator < MIN_COMPARISON_N,
});

const confirmedVerdict = (f: AttemptFact): boolean => f.confirmation === "confirmed" && (f.verdict === "correct" || f.verdict === "incorrect" || f.verdict === "idk");
const isPending = (f: AttemptFact): boolean => f.verdict === "pending" || f.verdict === "ambiguous" || (f.confirmation !== "confirmed" && f.verdict !== "idk");
const unaided = (f: AttemptFact): boolean => f.hints === 0 && !f.answerSeen;
const correct = (f: AttemptFact): boolean => f.verdict === "correct";

/** Monday of the week of a local date (YYYY-MM-DD), computed on the calendar date only: no time zone surprises. */
export function weekStart(localDate: string): string {
  const d = new Date(`${localDate}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(d.getTime() - dow * DAY).toISOString().slice(0, 10);
}
const addDays = (localDate: string, n: number): string => new Date(new Date(`${localDate}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);

export interface WindowStat {
  from: string;
  to: string;
  firstTry: Ratio;
  heldout: Ratio;
  /** counts by format inside the window: if the mixes differ the comparison says so */
  formatMix: Record<string, number>;
}
export interface Comparison {
  current: WindowStat;
  previous: WindowStat;
  /** "ok" only when both windows have >= 10 observations of the series; otherwise no claim of change is made */
  status: "ok" | "insufficient_comparison_data";
  mixDiffers: boolean;
}

export interface RecurringError {
  skillId: string;
  firstFailure: string;
  lastFailure: string;
  failuresAfterFirst: number;
  opportunitiesAfterFirst: number;
  /** days between the first and the last confirmed failure */
  spanDays: number;
  contexts: number;
}

export interface Report {
  version: string;
  asOf: string;
  timezone: string;
  cohort: { criterionVersion: string; difficulty: string; protocol: string };
  counts: { attempts: number; slots: number };
  metrics: {
    firstAttemptAccuracy: Ratio & { assisted: { attempts: number; correct: number } };
    practiceAccuracy: Ratio & { note: string };
    heldoutAccuracy: Ratio;
    delayedRetention: Ratio;
    errorRecurrence: { skills: number; failuresAfterFirst: number; opportunitiesAfterFirst: number; rate: Ratio };
    idk: Ratio;
    skip: Ratio;
    pending: { slots: number; attempts: number };
    sessionProgress: { sessionId: string | null; closed: number; total: number };
    courseProgress: { completedBlueprints: number; publishedBlueprints: number };
    /** bank = in approved exercises, displayed = actually shown in a slot; never added together */
    vocabulary: { available: boolean; words: number; learned: number; bankOccurrences: number; displayedOccurrences: number };
  };
  byDimension: Record<"recognition" | "correction" | "production", Ratio>;
  skills: Array<{ skillId: string; failures: number; opportunities: number; rate: Ratio }>;
  recurring: RecurringError[];
  weeklyHeldout: Array<{ week: string; heldout: Ratio }>;
  weeklyFirstTry: Array<{ week: string; firstTry: Ratio }>;
  comparison: Comparison;
  activity: Array<{ date: string; attempts: number }>;
  /** other cohorts that exist in the data but are deliberately not mixed into this report */
  otherCohorts: Array<{ criterionVersion: string; difficulty: string; protocol: string; attempts: number }>;
  /** where the series changes underneath: scoring or model versions seen in this cohort, with first/last dates */
  changeMarkers: Array<{ kind: "assessment_model"; id: string; firstDate: string; lastDate: string; attempts: number }>;
}

export interface MetricInput {
  asOf: string;
  asOfLocalDate: string;
  timezone: string;
  cohort: { criterionVersion: string; difficulty: string; protocol: string };
  facts: AttemptFact[];
  allFacts: AttemptFact[];
  slots: SlotFact[];
  evidence: RawEvidenceRow[];
  activity: ReadonlyMap<string, string[]>;
  contextOf: (evidenceId: string) => string | null;
  progress: { sessionId: string | null; closed: number; total: number; completedBlueprints: number; publishedBlueprints: number };
  modelTags: ReadonlyMap<string, string>;
  vocabulary: { words: number; learned: number; bankOccurrences: number; displayedOccurrences: number };
}

function windowStat(facts: AttemptFact[], from: string, to: string): WindowStat {
  const inW = facts.filter((f) => f.localDate >= from && f.localDate <= to);
  const first = inW.filter((f) => f.first && unaided(f) && confirmedVerdict(f));
  const held = first.filter((f) => f.purpose === "heldout");
  const formatMix: Record<string, number> = {};
  for (const f of first) formatMix[f.format] = (formatMix[f.format] ?? 0) + 1;
  return { from, to, firstTry: ratio(first.filter(correct).length, first.length), heldout: ratio(held.filter(correct).length, held.length), formatMix };
}

export function buildMetrics(i: MetricInput): Report {
  const facts = i.facts;
  const firstConfirmed = facts.filter((f) => f.first && confirmedVerdict(f));
  const firstUnaided = firstConfirmed.filter(unaided);
  const assisted = firstConfirmed.filter((f) => !unaided(f));

  // practice accuracy: the LAST confirmed answer of each slot (retries allowed, so assisted retries are included and said so)
  const lastBySlot = new Map<string, AttemptFact>();
  for (const f of facts) {
    const cur = lastBySlot.get(f.slotId);
    if (!cur || f.attemptNo > cur.attemptNo) lastBySlot.set(f.slotId, f);
  }
  const lastConfirmed = [...lastBySlot.values()].filter(confirmedVerdict);

  const heldFirst = firstUnaided.filter((f) => f.purpose === "heldout");

  // delayed retention: confirmed independent evidence marked delayed by the same rule Mastery uses (>= 7 days after the last practice of the skill)
  const bySkillDim = new Map<string, RawEvidenceRow[]>();
  for (const e of i.evidence) (bySkillDim.get(`${e.skillId}|${e.dimension}`) ?? bySkillDim.set(`${e.skillId}|${e.dimension}`, []).get(`${e.skillId}|${e.dimension}`)!).push(e);
  let delayedN = 0;
  let delayedOk = 0;
  for (const [key, rows] of bySkillDim) {
    for (const m of markDelayedProbes(rows.map((r) => ({ ...r })), i.activity.get(key) ?? [], MASTERY_V1)) {
      if (m.delayedProbe) {
        delayedN++;
        if (m.success) delayedOk++;
      }
    }
  }

  // error recurrence and per-skill failures (confirmed independent evidence only); a first failure is excluded from the recurrence ratio
  const bySkill = new Map<string, RawEvidenceRow[]>();
  for (const e of i.evidence) (bySkill.get(e.skillId) ?? bySkill.set(e.skillId, []).get(e.skillId)!).push(e);
  const skills = [...bySkill.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([skillId, rows]) => {
      const failures = rows.filter((r) => !r.success).length;
      return { skillId, failures, opportunities: rows.length, rate: ratio(failures, rows.length) };
    });
  const recurring: RecurringError[] = [];
  let recAfter = 0;
  let recOpp = 0;
  for (const [skillId, rows] of [...bySkill.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const sorted = [...rows].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
    const idx = sorted.findIndex((r) => !r.success);
    if (idx < 0) continue;
    const after = sorted.slice(idx + 1);
    const fails = after.filter((r) => !r.success);
    recAfter += fails.length;
    recOpp += after.length;
    if (fails.length > 0) {
      const all = [sorted[idx]!, ...fails];
      recurring.push({
        skillId,
        firstFailure: sorted[idx]!.localDate,
        lastFailure: fails[fails.length - 1]!.localDate,
        failuresAfterFirst: fails.length,
        opportunitiesAfterFirst: after.length,
        spanDays: Math.round((Date.parse(`${fails[fails.length - 1]!.localDate}T00:00:00Z`) - Date.parse(`${sorted[idx]!.localDate}T00:00:00Z`)) / DAY),
        contexts: new Set(all.map((r) => i.contextOf(r.id)).filter((c): c is string => c !== null)).size,
      });
    }
  }

  const byDimension = Object.fromEntries((["recognition", "correction", "production"] as const).map((d) => {
    const rows = firstUnaided.filter((f) => f.dimension === d);
    return [d, ratio(rows.filter(correct).length, rows.length)];
  })) as Report["byDimension"];

  // weekly series (Monday start, local calendar dates), gaps kept so that "no data" is visible and not drawn as a line
  const weeks = (pick: (f: AttemptFact) => boolean): Array<{ week: string; r: Ratio }> => {
    const rows = firstUnaided.filter(pick);
    if (firstUnaided.length === 0) return [];
    const all = firstUnaided.map((f) => weekStart(f.localDate)).sort();
    const out: Array<{ week: string; r: Ratio }> = [];
    for (let w = all[0]!; w <= all[all.length - 1]!; w = addDays(w, 7)) {
      const inWeek = rows.filter((f) => weekStart(f.localDate) === w);
      out.push({ week: w, r: ratio(inWeek.filter(correct).length, inWeek.length) });
    }
    return out;
  };

  const cur = windowStat(facts, addDays(i.asOfLocalDate, -27), i.asOfLocalDate);
  const prev = windowStat(facts, addDays(i.asOfLocalDate, -55), addDays(i.asOfLocalDate, -28));
  const mixKeys = new Set([...Object.keys(cur.formatMix), ...Object.keys(prev.formatMix)]);
  const total = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0) || 1;
  const mixDiffers = [...mixKeys].some((k) => Math.abs((cur.formatMix[k] ?? 0) / total(cur.formatMix) - (prev.formatMix[k] ?? 0) / total(prev.formatMix)) > 0.2);
  const comparison: Comparison = { current: cur, previous: prev, status: cur.firstTry.denominator >= MIN_COMPARISON_N && prev.firstTry.denominator >= MIN_COMPARISON_N ? "ok" : "insufficient_comparison_data", mixDiffers };

  const activityMap = new Map<string, number>();
  for (const f of i.allFacts) activityMap.set(f.localDate, (activityMap.get(f.localDate) ?? 0) + 1);

  const other = new Map<string, { criterionVersion: string; difficulty: string; protocol: string; attempts: number }>();
  for (const f of i.allFacts) {
    if (f.criterion === i.cohort.criterionVersion && f.difficulty === i.cohort.difficulty && f.protocol === i.cohort.protocol) continue;
    const k = `${f.criterion}|${f.difficulty}|${f.protocol}`;
    const e = other.get(k) ?? { criterionVersion: f.criterion, difficulty: f.difficulty, protocol: f.protocol, attempts: 0 };
    e.attempts++;
    other.set(k, e);
  }

  const markers = new Map<string, { id: string; firstDate: string; lastDate: string; attempts: number }>();
  for (const f of facts) {
    if (f.assessmentSource !== "model" || !f.modelVersionId) continue;
    const id = i.modelTags.get(f.modelVersionId) ?? f.modelVersionId;
    const e = markers.get(id) ?? { id, firstDate: f.localDate, lastDate: f.localDate, attempts: 0 };
    e.firstDate = f.localDate < e.firstDate ? f.localDate : e.firstDate;
    e.lastDate = f.localDate > e.lastDate ? f.localDate : e.lastDate;
    e.attempts++;
    markers.set(id, e);
  }

  const idkAttempts = facts.filter((f) => f.attemptNo === 1);
  const revealed = i.slots.filter((s) => s.revealed);
  const pendingLast = [...lastBySlot.values()].filter(isPending);

  return {
    version: REPORT_VERSION,
    asOf: i.asOf,
    timezone: i.timezone,
    cohort: i.cohort,
    counts: { attempts: facts.length, slots: i.slots.length },
    metrics: {
      firstAttemptAccuracy: { ...ratio(firstUnaided.filter(correct).length, firstUnaided.length), assisted: { attempts: assisted.length, correct: assisted.filter(correct).length } },
      practiceAccuracy: { ...ratio(lastConfirmed.filter(correct).length, lastConfirmed.length), note: "includes assisted retries; the unaided first-try accuracy is shown next to it" },
      heldoutAccuracy: ratio(heldFirst.filter(correct).length, heldFirst.length),
      delayedRetention: ratio(delayedOk, delayedN),
      errorRecurrence: { skills: recurring.length, failuresAfterFirst: recAfter, opportunitiesAfterFirst: recOpp, rate: ratio(recAfter, recOpp) },
      idk: ratio(idkAttempts.filter((f) => f.idk).length, idkAttempts.length),
      skip: ratio(revealed.filter((s) => s.skipped).length, revealed.length),
      pending: { slots: pendingLast.length, attempts: facts.filter(isPending).length },
      sessionProgress: { sessionId: i.progress.sessionId, closed: i.progress.closed, total: i.progress.total },
      courseProgress: { completedBlueprints: i.progress.completedBlueprints, publishedBlueprints: i.progress.publishedBlueprints },
      vocabulary: { available: true, words: i.vocabulary.words, learned: i.vocabulary.learned, bankOccurrences: i.vocabulary.bankOccurrences, displayedOccurrences: i.vocabulary.displayedOccurrences },
    },
    byDimension,
    skills,
    recurring,
    weeklyHeldout: weeks((f) => f.purpose === "heldout").map((w) => ({ week: w.week, heldout: w.r })),
    weeklyFirstTry: weeks(() => true).map((w) => ({ week: w.week, firstTry: w.r })),
    comparison,
    activity: [...activityMap.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, attempts]) => ({ date, attempts })),
    otherCohorts: [...other.values()].sort((a, b) => (a.criterionVersion + a.difficulty + a.protocol < b.criterionVersion + b.difficulty + b.protocol ? -1 : 1)),
    changeMarkers: [...markers.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((m) => ({ kind: "assessment_model" as const, ...m })),
  };
}
