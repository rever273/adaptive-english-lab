/**
 * Reads a column-oriented gap-fill dataset (TASK_032): five top-level fields, each an object keyed by the record index.
 * The loader never prints rows; callers only get counts and bounded samples.
 */
export interface RawRow {
  sourceIndex: number;
  gappedText: string;
  solution: string;
  distractors: string[];
  filledText: string;
  sourceTopic: string;
}
export interface Rejection {
  sourceIndex: number;
  reason: string;
  detail?: string;
}

export const COLUMNS = ["gapped_text", "solution", "distractors", "filled_text", "grammar_topic"] as const;

export function readColumnar(data: unknown): { rows: RawRow[]; rejected: Rejection[]; indexSetsMatch: boolean } {
  const d = data as Record<string, Record<string, unknown>>;
  for (const c of COLUMNS) if (!d || typeof d[c] !== "object" || d[c] === null) throw new Error(`dataset field missing: ${c}`);
  const sets = COLUMNS.map((c) => new Set(Object.keys(d[c]!)));
  const all = new Set<string>(sets.flatMap((s) => [...s]));
  const indexSetsMatch = sets.every((s) => s.size === all.size);
  const rows: RawRow[] = [];
  const rejected: Rejection[] = [];
  const indices = [...all].map((k) => ({ k, n: Number(k) })).sort((a, b) => a.n - b.n);
  for (const { k, n } of indices) {
    if (!Number.isInteger(n) || n < 0) { rejected.push({ sourceIndex: -1, reason: "bad_index", detail: k.slice(0, 40) }); continue; }
    if (!COLUMNS.every((c) => k in d[c]!)) { rejected.push({ sourceIndex: n, reason: "field_missing" }); continue; }
    const g = d.gapped_text![k], s = d.solution![k], x = d.distractors![k], f = d.filled_text![k], t = d.grammar_topic![k];
    if (typeof g !== "string" || typeof s !== "string" || typeof f !== "string" || typeof t !== "string" || !Array.isArray(x) || x.some((o) => typeof o !== "string")) { rejected.push({ sourceIndex: n, reason: "field_type" }); continue; }
    if (g.trim() === "" || s.trim() === "" || f.trim() === "" || t.trim() === "") { rejected.push({ sourceIndex: n, reason: "empty_field" }); continue; }
    rows.push({ sourceIndex: n, gappedText: g, solution: s, distractors: x as string[], filledText: f, sourceTopic: t });
  }
  return { rows, rejected, indexSetsMatch };
}
