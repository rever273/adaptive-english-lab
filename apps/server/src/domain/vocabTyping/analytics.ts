import { VT_ATTRIBUTION, type VtAnalytics, type VtBandRow } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { allocateDays, DAILY_TIMEZONE, learningDate } from "../journey/calendar.js";
import { assumedKnown, bandInputs, estimateNow, estimateView, loadFacts, type Deps } from "./data.js";
import { estimateVocabulary } from "./estimate.js";
import { wordInfos } from "./overview.js";
import { addDays, summarise, type VtFact } from "./state.js";

const MAX_POINTS = 60;
const MAX_DAILY = 366;
const KNOWN_STATES = new Set(["known_screening", "awaiting_verification", "verified"]);

/** Monday of the learning week of a date */
function weekStart(date: string): string {
  const day = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -day);
}

/** the read model of the Analyze tab: everything is computed from the raw events, sessions and intervals on request (nothing is stored) */
export function buildAnalytics(db: Db, deps: Deps, days: number): VtAnalytics {
  const today = learningDate(deps.now().getTime());
  const cutoff = addDays(today, -(days - 1));
  const facts = loadFacts(db);
  const infos = wordInfos(db);
  const pool = infos.filter((w) => w.inPool);
  const stateCount = (s: string): number => pool.filter((w) => w.summary.state === s).length;
  const est = estimateNow(db, facts);
  const assumed = assumedKnown(db);
  const poolSet = new Set(pool.map((w) => w.row.lemma));

  const bandRows = new Map<number, VtBandRow>();
  for (const b of est.bands) bandRows.set(b.band, { band: b.band, pool: b.pool, screened: b.screened, known: b.known, share: b.screened > 0 ? b.known / b.screened : null });

  // the day-by-day estimate: the facts as they stood at the end of each day (the pool is today's)
  const first = [...facts.values()].flat().map((f) => f.date).sort()[0] ?? today;
  const from = first > cutoff ? first : cutoff;
  const span = Math.max(1, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1);
  const step = Math.max(1, Math.ceil(span / MAX_POINTS));
  const dates: string[] = [];
  for (let i = 0; i < span; i += step) dates.push(addDays(from, i));
  if (dates[dates.length - 1] !== today) dates.push(today);
  const series = dates.map((date) => {
    const e = estimateVocabulary(bandInputs(db, facts, date), assumed);
    let known = 0;
    for (const [lemma, list] of facts) if (poolSet.has(lemma) && KNOWN_STATES.has(summarise(list.filter((f: VtFact) => f.date <= date)).state)) known++;
    return { date, estimate: e.estimate, knownNow: known + assumed };
  });

  // per-day figures of the period, from the raw rows
  const dailyFrom = addDays(today, -(Math.min(days, MAX_DAILY) - 1));
  const day = new Map<string, { date: string; ms: number; chars: number; errors: number; activeMs: number; known: number; unknown: number; notUseful: number; learned: number; verified: number }>();
  for (let d = dailyFrom; d <= today; d = addDays(d, 1)) day.set(d, { date: d, ms: 0, chars: 0, errors: 0, activeMs: 0, known: 0, unknown: 0, notUseful: 0, learned: 0, verified: 0 });
  for (const r of db.prepare("SELECT local_date AS d, kind, typing_json AS t FROM vocab_typing_events WHERE local_date >= ?").all(dailyFrom) as Array<{ d: string; kind: string; t: string }>) {
    const x = day.get(r.d);
    if (!x) continue;
    if (r.kind === "screen_known") x.known++;
    else if (r.kind === "screen_unknown") x.unknown++;
    else if (r.kind === "screen_not_useful" || r.kind === "screen_archived") x.notUseful++;
    else if (r.kind === "learn_learned") x.learned++;
    const t = JSON.parse(r.t) as { activeMs?: number; chars?: number; errors?: number };
    x.activeMs += t.activeMs ?? 0;
    x.chars += t.chars ?? 0;
    x.errors += t.errors ?? 0;
  }
  const weeks = new Map<string, { passed: number; failed: number }>();
  for (const r of db.prepare("SELECT local_date AS d, rating FROM vocab_typing_reviews WHERE rating IS NOT NULL AND local_date >= ?").all(cutoff) as Array<{ d: string; rating: string }>) {
    const x = day.get(r.d);
    if (x && r.rating === "good") x.verified++;
    const w = weeks.get(weekStart(r.d)) ?? { passed: 0, failed: 0 };
    if (r.rating === "good") w.passed++;
    else w.failed++;
    weeks.set(weekStart(r.d), w);
  }
  const intervals = db.prepare("SELECT start_ms AS s, end_ms AS e FROM vocab_typing_activity_intervals WHERE end_ms >= ?").all(Date.parse(`${dailyFrom}T00:00:00Z`) - 86_400_000) as Array<{ s: number; e: number }>;
  for (const i of intervals) {
    for (const part of allocateDays(i.s, i.e, DAILY_TIMEZONE)) {
      const x = day.get(part.date);
      if (x) x.ms += part.ms;
    }
  }
  const daily = [...day.values()].map((x) => ({
    date: x.date,
    wpm: x.activeMs > 0 ? Math.round((x.chars / 5 / (x.activeMs / 60000)) * 10) / 10 : null,
    accuracy: x.chars + x.errors > 0 ? Math.round((x.chars / (x.chars + x.errors)) * 1000) / 10 : null,
    minutes: Math.round((x.ms / 60000) * 10) / 10,
    known: x.known,
    unknown: x.unknown,
    notUseful: x.notUseful,
    learned: x.learned,
    verified: x.verified,
  }));
  const weekly = [...weeks].sort((a, b) => a[0].localeCompare(b[0])).map(([week, w]) => ({ week, passed: w.passed, failed: w.failed, rate: w.passed + w.failed > 0 ? Math.round((w.passed / (w.passed + w.failed)) * 1000) / 10 : null }));
  const dueForecast = Array.from({ length: 14 }, (_, i) => ({ date: addDays(today, i), count: 0 }));
  for (const w of pool) {
    if (w.nextCheck === null) continue;
    const target = w.nextCheck < today ? today : w.nextCheck;
    const slot = dueForecast.find((d) => d.date === target);
    if (slot) slot.count++;
  }

  const learner = infos.filter((w) => w.summary.state === "excluded_by_learner").length;
  const learningRows = pool.filter((w) => w.summary.state === "learning");
  const inPeriod = (f: VtFact): boolean => f.date >= cutoff;
  const lemmasWith = (kind: VtFact["kind"]): number => [...facts.values()].filter((list) => list.some((f) => f.kind === kind && inPeriod(f))).length;
  const checks = (kind: VtFact["kind"]): number => [...facts.values()].reduce((n, list) => n + list.filter((f) => f.kind === kind && inPeriod(f)).length, 0);

  const sessions = db.prepare("SELECT id, active_ms AS ms, chars_typed AS chars, errors, wpm, accuracy, key_stats_json AS ks, ended_at AS endedAt FROM vocab_typing_sessions WHERE status = 'completed' AND active_ms IS NOT NULL").all() as Array<{ id: string; ms: number; chars: number; errors: number; wpm: number | null; accuracy: number | null; ks: string | null; endedAt: string }>;
  const mine = sessions.filter((s) => learningDate(Date.parse(s.endedAt)) >= cutoff);
  const ms = mine.reduce((n, s) => n + s.ms, 0);
  const chars = mine.reduce((n, s) => n + s.chars, 0);
  const errors = mine.reduce((n, s) => n + s.errors, 0);
  const pairs = new Map<string, { count: number; errors: number }>();
  for (const s of mine) {
    if (!s.ks) continue;
    for (const p of JSON.parse(s.ks) as Array<{ pair: string; count: number; errors: number }>) {
      const cur = pairs.get(p.pair) ?? { count: 0, errors: 0 };
      pairs.set(p.pair, { count: cur.count + p.count, errors: cur.errors + p.errors });
    }
  }
  const troublePairs = [...pairs]
    .filter(([, p]) => p.count + p.errors >= 8 && p.errors > 0)
    .map(([pair, p]) => ({ pair, errorRate: Math.round((p.errors / (p.count + p.errors)) * 1000) / 1000, count: p.count + p.errors }))
    .sort((a, b) => b.errorRate - a.errorRate || b.count - a.count)
    .slice(0, 5);
  const cardsOf = db.prepare("SELECT COUNT(*) AS n FROM (SELECT session_id FROM vocab_typing_events UNION ALL SELECT session_id FROM vocab_typing_reviews) GROUP BY session_id").all() as Array<{ n: number }>;
  const records = {
    bestWpm: sessions.reduce<number | null>((m, s) => (s.chars >= 20 && s.wpm !== null && (m === null || s.wpm > m) ? s.wpm : m), null),
    bestAccuracy: sessions.reduce<number | null>((m, s) => (s.chars >= 20 && s.accuracy !== null && (m === null || s.accuracy > m) ? s.accuracy : m), null),
    mostCards: cardsOf.reduce((m, s) => Math.max(m, s.n), 0),
    longestMs: sessions.reduce((m, s) => Math.max(m, s.ms), 0),
  };

  const knownScreening = stateCount("known_screening");
  const awaiting = stateCount("awaiting_verification");
  const verified = stateCount("verified");
  const newWords = (state: string): number => pool.filter((w) => w.summary.state === state && w.summary.originalScreen === "unknown").length;
  const dueNow = pool.filter((w) => w.nextCheck !== null && w.nextCheck <= today && w.usable > 0).length;
  const dueNext7 = pool.filter((w) => w.nextCheck !== null && w.nextCheck > today && w.nextCheck <= addDays(today, 7)).length;
  const screened = pool.filter((w) => w.summary.originalScreen !== null).length;

  return {
    days,
    estimate: estimateView(est),
    knownNow: { total: knownScreening + awaiting + verified + assumed, knownScreening, awaiting, verified },
    newWordsLearned: { selfReported: newWords("awaiting_verification"), verified: newWords("verified") },
    series,
    bands: [...bandRows.values()].sort((a, b) => a.band - b.band),
    excluded: { cleanup: infos.filter((w) => w.row.eligibility === "excluded" && w.summary.state !== "excluded_by_learner").length, learner },
    daily,
    weekly,
    dueForecast,
    records,
    screening: { screened, remaining: pool.length - screened, probes: est.probes },
    learning: { learning: learningRows.length, awaiting, verified, dueNow, dueNext7, checksPassed: checks("review_good"), checksFailed: checks("review_again"), returnedToLearning: lemmasWith("review_again"), noExamples: learningRows.filter((w) => w.usable === 0).length },
    typing: { sessions: mine.length, wpm: ms > 0 ? Math.round((chars / 5 / (ms / 60000)) * 10) / 10 : null, accuracy: chars + errors > 0 ? Math.round((chars / (chars + errors)) * 1000) / 10 : null, errors, activeMs: ms, troublePairs },
    attribution: VT_ATTRIBUTION,
  };
}
