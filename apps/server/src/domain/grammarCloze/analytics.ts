import type { ClozeStageView } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { learningDate } from "../../routes/journey.js";
import { ruleName, stageView } from "./repository.js";

export type Days = "7" | "30" | "90" | "all";
export interface ClozeAnalytics {
  totals: { sessions: number; answered: number; correct: number; incorrect: number; excluded: number; activeMs: number };
  byDay: Array<{ day: string; answered: number; correct: number; activeMs: number; medianMs: number | null }>;
  /** accuracy by learning week (Monday first), with the counts behind it */
  weekly: Array<{ week: string; answered: number; correct: number }>;
  /** last 28 days against the 28 before, whatever the period filter says */
  comparison: { current: Window; previous: Window };
  /** share of Stage 1 answered at the end of each day with answers (all time up to that day, shown for the period) */
  progress: Array<{ day: string; processed: number; percent: number }>;
  /** every rule answered in the period (most answers first) with their accuracy per bucket; null = no answers in that bucket */
  ruleSeries: { bucket: "day" | "week"; labels: string[]; series: Array<{ ruleKey: string; name: string; answered: number; accuracy: Array<number | null>; counts: number[] }> };
  byRule: Array<{ ruleKey: string; name: string; exact: boolean; answered: number; correct: number; accuracy: number }>;
  responseMs: { median: number | null; p75: number | null };
  stages: ClozeStageView[];
}
interface Window {
  from: string;
  to: string;
  answered: number;
  correct: number;
}

const MS_DAY = 86400000;
const quantile = (sorted: number[], q: number): number | null => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!);
const dayShift = (day: string, n: number): string => new Date(Date.parse(day + "T00:00:00Z") + n * MS_DAY).toISOString().slice(0, 10);
/** Monday of the week that holds this learning date */
export const weekStart = (day: string): string => {
  const dow = new Date(Date.parse(day + "T00:00:00Z")).getUTCDay();
  return dayShift(day, -((dow + 6) % 7));
};

/** Statistics of the mode only (never mixed with the classic Grammar numbers). The period filters answers and time; the stage cards are always whole. */
export function clozeAnalytics(db: Db, days: Days, now: Date): ClozeAnalytics {
  const cutoffMs = days === "all" ? 0 : now.getTime() - Number(days) * MS_DAY;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const everything = db.prepare("SELECT answered_at AS at, is_correct AS ok, rule_key AS ruleKey, response_ms AS ms, session_id AS sid FROM grammar_cloze_attempts ORDER BY answered_at").all() as Array<{ at: string; ok: number; ruleKey: string; ms: number | null; sid: string }>;
  const attempts = everything.filter((a) => a.at >= cutoffIso);
  const intervals = db.prepare("SELECT start_ms AS s, end_ms AS e FROM grammar_cloze_activity_intervals WHERE end_ms >= ?").all(cutoffMs) as Array<{ s: number; e: number }>;

  const byDay = new Map<string, { day: string; answered: number; correct: number; activeMs: number; times: number[] }>();
  const dayOf = (ms: number) => {
    const day = learningDate(ms);
    return byDay.get(day) ?? byDay.set(day, { day, answered: 0, correct: 0, activeMs: 0, times: [] }).get(day)!;
  };
  for (const a of attempts) { const d = dayOf(Date.parse(a.at)); d.answered++; d.correct += a.ok; if (a.ms !== null) d.times.push(a.ms); }
  for (const i of intervals) dayOf(i.s).activeMs += i.e - i.s;
  const dayRows = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).map(({ times, ...d }) => ({ ...d, medianMs: quantile([...times].sort((x, y) => x - y), 0.5) }));

  const rules = new Map<string, { answered: number; correct: number }>();
  for (const a of attempts) { const r = rules.get(a.ruleKey) ?? { answered: 0, correct: 0 }; r.answered++; r.correct += a.ok; rules.set(a.ruleKey, r); }
  const times = attempts.map((a) => a.ms).filter((m): m is number => m !== null).sort((a, b) => a - b);
  const excluded = (db.prepare("SELECT COUNT(*) AS n FROM grammar_cloze_exclusions WHERE created_at >= ?").get(cutoffIso) as { n: number }).n;
  const correct = attempts.filter((a) => a.ok === 1).length;

  const weeks = new Map<string, { week: string; answered: number; correct: number }>();
  for (const a of attempts) {
    const w = weekStart(learningDate(Date.parse(a.at)));
    const e = weeks.get(w) ?? weeks.set(w, { week: w, answered: 0, correct: 0 }).get(w)!;
    e.answered++;
    e.correct += a.ok;
  }

  const today = learningDate(now.getTime());
  const win = (fromOff: number, toOff: number): Window => {
    const from = dayShift(today, fromOff), to = dayShift(today, toOff);
    const inside = everything.filter((a) => { const d = learningDate(Date.parse(a.at)); return d >= from && d <= to; });
    return { from, to, answered: inside.length, correct: inside.filter((a) => a.ok === 1).length };
  };

  const total = stageView(db, 1).total;
  const perDay = new Map<string, number>();
  for (const a of everything) { const d = learningDate(Date.parse(a.at)); perDay.set(d, (perDay.get(d) ?? 0) + 1); }
  let running = 0;
  const progress: ClozeAnalytics["progress"] = [];
  const firstShown = dayRows[0]?.day ?? "";
  for (const d of [...perDay.keys()].sort()) {
    running += perDay.get(d)!;
    if (firstShown && d >= firstShown) progress.push({ day: d, processed: running, percent: total ? Math.min(100, (running / total) * 100) : 0 });
  }

  // the most important rules: the most answers in the period (ties: lower accuracy first), drawn as accuracy lines
  const bucket: "day" | "week" = days === "7" || dayRows.length <= 10 ? "day" : "week";
  const keyOf = (iso: string): string => (bucket === "day" ? learningDate(Date.parse(iso)) : weekStart(learningDate(Date.parse(iso))));
  const labels = [...new Set(attempts.map((a) => keyOf(a.at)))].sort();
  const top = [...rules.entries()].sort((a, b) => b[1].answered - a[1].answered || a[1].correct / a[1].answered - b[1].correct / b[1].answered);
  const series = top.map(([ruleKey, v]) => {
    const counts = labels.map(() => 0), right = labels.map(() => 0);
    for (const a of attempts) if (a.ruleKey === ruleKey) { const i = labels.indexOf(keyOf(a.at)); counts[i]!++; right[i]! += a.ok; }
    return { ruleKey, name: ruleName(ruleKey), answered: v.answered, accuracy: counts.map((c, i) => (c ? right[i]! / c : null)), counts };
  });

  return {
    totals: { sessions: new Set(attempts.map((a) => a.sid)).size, answered: attempts.length, correct, incorrect: attempts.length - correct, excluded, activeMs: intervals.reduce((n, i) => n + i.e - i.s, 0) },
    byDay: dayRows,
    weekly: [...weeks.values()].sort((a, b) => (a.week < b.week ? -1 : 1)),
    comparison: { current: win(-27, 0), previous: win(-55, -28) },
    progress,
    ruleSeries: { bucket, labels, series },
    byRule: [...rules.entries()].map(([ruleKey, v]) => ({ ruleKey, name: ruleName(ruleKey), exact: !ruleKey.startsWith("topic:"), answered: v.answered, correct: v.correct, accuracy: v.correct / v.answered })).sort((a, b) => a.accuracy - b.accuracy || b.answered - a.answered),
    responseMs: { median: quantile(times, 0.5), p75: quantile(times, 0.75) },
    stages: [stageView(db, 1), stageView(db, 2)],
  };
}
