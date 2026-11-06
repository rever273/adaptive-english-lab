import type { Db } from "../../db/open.js";

export interface KeyStat {
  pair: string;
  count: number;
  totalMs: number;
  errors: number;
}

/** pairs seen fewer times than this say nothing yet */
export const PAIR_MIN_COUNT = 8;

/** One session's letter-pair facts (append-only, one row per pair). Called inside the completion transaction. */
export function saveKeyStats(db: Db, newId: () => string, sessionId: string, stats: readonly KeyStat[], at: string): void {
  const put = db.prepare("INSERT OR IGNORE INTO typing_key_stats(id, session_id, pair, count, total_ms, errors, created_at) VALUES (?,?,?,?,?,?,?)");
  for (const s of stats) if (/^[a-z-]{2}$/.test(s.pair) && (s.count > 0 || s.errors > 0)) put.run(newId(), sessionId, s.pair, s.count, s.totalMs, s.errors, at);
}

export interface PairInsight {
  pair: string;
  count: number;
  meanMs: number;
  errorRate: number;
  /** slowness against the learner's own typical pair (1 = typical) */
  slowness: number;
}

/** All pairs seen often enough, with their mean interval and error rate over every finished session (derived, never stored). */
export function pairInsights(db: Db): PairInsight[] {
  const rows = db.prepare("SELECT pair, SUM(count) AS count, SUM(total_ms) AS ms, SUM(errors) AS errors FROM typing_key_stats GROUP BY pair").all() as Array<{ pair: string; count: number; ms: number; errors: number }>;
  const seen = rows.filter((r) => r.count >= PAIR_MIN_COUNT);
  const totalCount = seen.reduce((a, r) => a + r.count, 0);
  const typical = totalCount > 0 ? seen.reduce((a, r) => a + r.ms, 0) / totalCount : 0;
  return seen.map((r) => {
    const meanMs = r.ms / r.count;
    return { pair: r.pair, count: r.count, meanMs: Math.round(meanMs), errorRate: Math.round((r.errors / (r.count + r.errors)) * 1000) / 1000, slowness: typical > 0 ? Math.round((meanMs / typical) * 100) / 100 : 1 };
  });
}

/** the pairs most worth practising: slow (well above the learner's typical interval) or often mistyped, strongest first */
export function weakPairs(db: Db, limit: number): string[] {
  return pairInsights(db)
    .map((p) => ({ p, weakness: Math.max(0, p.slowness - 1.25) + 6 * Math.max(0, p.errorRate - 0.04) }))
    .filter((x) => x.weakness > 0)
    .sort((a, b) => b.weakness - a.weakness || b.p.count - a.p.count)
    .slice(0, limit)
    .map((x) => x.p.pair);
}

/** the part of the insight worth showing in the statistics: a few slowest and a few most mistyped pairs */
export function keyInsights(db: Db): { slowPairs: Array<{ pair: string; meanMs: number; count: number }>; errorPairs: Array<{ pair: string; errorRate: number; count: number }>; typicalMs: number | null } {
  const all = pairInsights(db);
  const totalCount = all.reduce((a, p) => a + p.count, 0);
  const typicalMs = totalCount > 0 ? Math.round(all.reduce((a, p) => a + p.meanMs * p.count, 0) / totalCount) : null;
  return {
    slowPairs: [...all].sort((a, b) => b.slowness - a.slowness).slice(0, 5).map((p) => ({ pair: p.pair, meanMs: p.meanMs, count: p.count })),
    errorPairs: all.filter((p) => p.errorRate > 0).sort((a, b) => b.errorRate - a.errorRate).slice(0, 5).map((p) => ({ pair: p.pair, errorRate: p.errorRate, count: p.count })),
    typicalMs,
  };
}

/** true when a word contains one of the pairs */
export const hasPair = (lemma: string, pairs: readonly string[]): boolean => pairs.some((p) => lemma.includes(p));
