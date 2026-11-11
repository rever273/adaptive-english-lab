import type { Db } from "../../db/open.js";
import { weekStart } from "../grammarCloze/analytics.js";
import { displayName } from "../skills/cards.js";

export type TrendDays = "7" | "30" | "90" | "all";
export interface GrammarTrends {
  /** independent first tries per day: confirmed, no hint, no answer seen, not "I don't know", not a repeat */
  byDay: Array<{ date: string; scored: number; correct: number; medianMs: number | null }>;
  /** the most practised skills with their accuracy per bucket (null = no scored tries in that bucket) */
  skillSeries: { bucket: "day" | "week"; labels: string[]; series: Array<{ skillId: string; name: string; answered: number; accuracy: Array<number | null>; counts: number[] }> };
}

const quantile = (sorted: number[], q: number): number | null => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!);

/**
 * Trends of the classic Grammar Practice for the Analytics charts, from the same attempts the "Independent results per day" chart uses.
 * Read-only: derived numbers, nothing is written.
 */
export function grammarTrends(db: Db, days: TrendDays, now: Date): GrammarTrends {
  const cutoff = days === "all" ? "0000-00-00" : new Date(now.getTime() - Number(days) * 86400000).toISOString().slice(0, 10);
  const rows = db
    .prepare(
      `SELECT t.local_date AS date, t.latency_ms AS ms, t.id AS attemptId, a.verdict AS verdict
         FROM attempts t JOIN session_slots ss ON ss.id = t.slot_id
         LEFT JOIN vocabulary_sessions v ON v.session_id = ss.session_id
         JOIN assessment_revisions a ON a.attempt_id = t.id AND a.sequence = (SELECT MAX(ar.sequence) FROM assessment_revisions ar WHERE ar.attempt_id = t.id)
        WHERE v.session_id IS NULL AND t.attempt_no = 1 AND t.hints_before = 0 AND t.answer_seen_before = 0 AND t.idk = 0
          AND COALESCE(json_extract(ss.cohort_json, '$.repeat'), 0) <> 1 AND a.confirmation = 'confirmed' AND a.verdict IN ('correct','incorrect') AND t.local_date >= ?
        ORDER BY t.local_date`,
    )
    .all(cutoff) as Array<{ date: string; ms: number | null; attemptId: string; verdict: string }>;
  const byDay = new Map<string, { scored: number; correct: number; times: number[] }>();
  for (const r of rows) {
    const d = byDay.get(r.date) ?? byDay.set(r.date, { scored: 0, correct: 0, times: [] }).get(r.date)!;
    d.scored++;
    if (r.verdict === "correct") d.correct++;
    if (r.ms !== null) d.times.push(r.ms);
  }
  const dayRows = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, d]) => ({ date, scored: d.scored, correct: d.correct, medianMs: quantile([...d.times].sort((x, y) => x - y), 0.5) }));

  const opp = db
    .prepare(
      `SELECT t.local_date AS date, sr.skill_id AS skillId, o.result AS result
         FROM attempts t JOIN session_slots ss ON ss.id = t.slot_id
         LEFT JOIN vocabulary_sessions v ON v.session_id = ss.session_id
         JOIN assessment_revisions a ON a.attempt_id = t.id AND a.sequence = (SELECT MAX(ar.sequence) FROM assessment_revisions ar WHERE ar.attempt_id = t.id)
         JOIN skill_opportunities o ON o.assessment_id = a.id AND o.target = 1 AND o.result IN ('success','failure')
         JOIN skill_revisions sr ON sr.id = o.skill_revision_id
        WHERE v.session_id IS NULL AND t.attempt_no = 1 AND t.hints_before = 0 AND t.answer_seen_before = 0 AND t.idk = 0
          AND COALESCE(json_extract(ss.cohort_json, '$.repeat'), 0) <> 1 AND a.confirmation = 'confirmed' AND a.verdict IN ('correct','incorrect') AND t.local_date >= ?`,
    )
    .all(cutoff) as Array<{ date: string; skillId: string; result: string }>;
  const bucket: "day" | "week" = days === "7" || dayRows.length <= 10 ? "day" : "week";
  const keyOf = (date: string): string => (bucket === "day" ? date : weekStart(date));
  const labels = [...new Set(opp.map((o) => keyOf(o.date)))].sort();
  const per = new Map<string, { answered: number; counts: number[]; right: number[] }>();
  for (const o of opp) {
    const e = per.get(o.skillId) ?? per.set(o.skillId, { answered: 0, counts: labels.map(() => 0), right: labels.map(() => 0) }).get(o.skillId)!;
    const i = labels.indexOf(keyOf(o.date));
    e.answered++;
    e.counts[i]!++;
    if (o.result === "success") e.right[i]!++;
  }
  const series = [...per.entries()]
    .sort((a, b) => b[1].answered - a[1].answered)
    .slice(0, 8)
    .map(([skillId, e]) => ({ skillId, name: displayName(skillId), answered: e.answered, counts: e.counts, accuracy: e.counts.map((c, i) => (c ? e.right[i]! / c : null)) }));
  return { byDay: dayRows, skillSeries: { bucket, labels, series } };
}
