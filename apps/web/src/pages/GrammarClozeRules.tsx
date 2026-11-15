import { useEffect, useMemo, useState } from "react";
import type { ClozeAnalyticsData } from "../api";
import { Chart } from "../components/Chart";

const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

/** one rule, or one grammar type when grouped (the part of the skill id before the dot: tenses, conditionals ...) */
interface RuleRow {
  key: string;
  name: string;
  note: string;
  group: string;
  answered: number;
  correct: number;
  accuracy: number;
  /** accuracy per time bucket (null = no answers) with the counts behind it */
  values: Array<number | null>;
  counts: number[];
}
type SortKey = "name" | "answered" | "slips" | "accuracy";

const GENERAL = "General Grammar";
const humanise = (id: string): string => {
  const s = id.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};
/** sentences the classifier could not tie to one rule only keep their source topic (present_simple, relatives ...): still a known grammar type */
const topicOf = (ruleKey: string): string => ruleKey.slice(6);
const groupOf = (ruleKey: string): string => {
  if (!ruleKey.startsWith("topic:")) return humanise(ruleKey.split(".")[0]!);
  const t = topicOf(ruleKey);
  if (/^(present|past|future)_/.test(t)) return "Tenses";
  if (t === "personal_pronouns") return "Pronouns";
  if (t === "non_finites") return "Verb patterns";
  return t ? humanise(t) : GENERAL;
};

function rowsOf(data: ClozeAnalyticsData, grouped: boolean): RuleRow[] {
  const labelsN = data.ruleSeries.labels.length;
  const seriesOf = new Map(data.ruleSeries.series.map((s) => [s.ruleKey, s]));
  const single: RuleRow[] = data.byRule.map((r) => {
    const s = seriesOf.get(r.ruleKey);
    return {
      key: r.ruleKey,
      name: r.exact ? r.name : `${humanise(topicOf(r.ruleKey))} (topic-level)`,
      note: "",
      group: groupOf(r.ruleKey),
      answered: r.answered,
      correct: r.correct,
      accuracy: r.accuracy,
      values: s?.accuracy ?? Array<number | null>(labelsN).fill(null),
      counts: s?.counts ?? Array<number>(labelsN).fill(0),
    };
  });
  if (!grouped) return single;
  const groups = new Map<string, RuleRow[]>();
  for (const r of single) (groups.get(r.group) ?? groups.set(r.group, []).get(r.group)!).push(r);
  return [...groups.entries()].map(([group, list]) => {
    const counts = data.ruleSeries.labels.map((_, i) => list.reduce((n, x) => n + x.counts[i]!, 0));
    const values = data.ruleSeries.labels.map((_, i) => (counts[i] ? list.reduce((n, x) => n + (x.values[i] === null ? 0 : x.values[i]! * x.counts[i]!), 0) / counts[i]! : null));
    const answered = list.reduce((n, x) => n + x.answered, 0);
    const correct = list.reduce((n, x) => n + x.correct, 0);
    return { key: `group:${group}`, name: group, note: `${list.length} rule${list.length === 1 ? "" : "s"}`, group, answered, correct, accuracy: correct / answered, values, counts };
  });
}

function ProgressDialog({ row, labels, onClose }: { row: RuleRow; labels: string[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="word-dialog-backdrop" onClick={onClose} data-testid="cloze-rule-dialog">
      <div className="word-dialog" role="dialog" aria-modal="true" aria-label={`Accuracy over time: ${row.name}`} onClick={(e) => e.stopPropagation()}>
        <div className="word-dialog-head">
          <h4 className="chart-title">{row.name}{row.note && <span className="muted small"> · {row.note}</span>}</h4>
          <button type="button" className="btn-small" onClick={onClose} autoFocus>Close</button>
        </div>
        <p className="muted small">{pct(row.accuracy)} correct overall: {row.correct} of {row.answered} first choices in this period.</p>
        <h5 className="chart-title">Accuracy over time</h5>
        <Chart
          connectGaps
          ariaLabel={`Accuracy over time for ${row.name}`}
          line={{ color: "#6ab7ff", format: (v) => `${Math.round(v * 100)}%`, max: 1 }}
          points={labels.map((l, i) => ({
            key: l,
            label: l.slice(5),
            line: row.values[i] ?? null,
            muted: row.counts[i]! < 5,
            tip: [l, row.counts[i] ? `${pct(row.values[i]!)} correct` : "no answers", `${row.counts[i]} answers`],
          }))}
          legend="Share of correct first choices in each day or week. Faded points have fewer than 5 answers; days without answers are skipped and the line joins the neighbouring points. A line that climbs means you are learning."
        />
      </div>
    </div>
  );
}

/** red (the lowest accuracy shown) to green (the highest shown): the colour scale follows the real range, not 0-100% */
const heat = (acc: number, lo: number, hi: number) => `hsl(${Math.round((hi > lo ? (acc - lo) / (hi - lo) : 1) * 120)} 55% 36%)`;

function Heatmap({ rows, onOpen }: { rows: RuleRow[]; onOpen: (r: RuleRow) => void }) {
  const [tip, setTip] = useState<{ x: number; y: number; row: RuleRow } | null>(null);
  const lo = Math.min(...rows.map((r) => r.accuracy));
  const hi = Math.max(...rows.map((r) => r.accuracy));
  const groups = useMemo(() => {
    const m = new Map<string, RuleRow[]>();
    for (const r of rows) (m.get(r.group) ?? m.set(r.group, []).get(r.group)!).push(r);
    return [...m.entries()].sort((a, b) => (a[0] === GENERAL ? 1 : b[0] === GENERAL ? -1 : a[0].localeCompare(b[0]))).map(([g, list]) => [g, [...list].sort((a, b) => a.name.localeCompare(b.name))] as const);
  }, [rows]);
  const show = (e: { currentTarget: HTMLElement; clientX: number; clientY: number }, row: RuleRow, fromKey = false) => {
    const box = e.currentTarget.closest(".cloze-heat")!.getBoundingClientRect();
    const own = e.currentTarget.getBoundingClientRect();
    setTip(fromKey ? { x: own.left - box.left + own.width / 2, y: own.top - box.top, row } : { x: e.clientX - box.left, y: e.clientY - box.top, row });
  };
  return (
    <div className="cloze-heat" data-testid="cloze-heatmap" onMouseLeave={() => setTip(null)}>
      {groups.map(([group, list]) => (
        <div className="cloze-heat-group" key={group}>
          <span className="cloze-heat-label">{group}</span>
          <div className="cloze-heat-cells">
            {list.map((r) => (
              <button
                type="button"
                key={r.key}
                className={`cloze-heat-cell${r.answered < 5 ? " few" : ""}`}
                style={{ background: heat(r.accuracy, lo, hi) }}
                aria-label={`${r.name}: ${Math.round(r.accuracy * 100)}% correct, practised ${r.answered} times`}
                onMouseMove={(e) => show(e, r)}
                onFocus={(e) => show(e as unknown as { currentTarget: HTMLElement; clientX: number; clientY: number }, r, true)}
                onBlur={() => setTip(null)}
                onClick={() => onOpen(r)}
              >
                {Math.round(r.accuracy * 100)}
              </button>
            ))}
          </div>
        </div>
      ))}
      {tip && (
        <div className="cloze-heat-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
          <strong>{tip.row.name}</strong>
          <span>{pct(tip.row.accuracy)} correct</span>
          <span>practised {tip.row.answered} {tip.row.answered === 1 ? "time" : "times"}{tip.row.answered < 5 ? " (few)" : ""}</span>
        </div>
      )}
      <div className="cloze-heat-scale" aria-hidden="true"><span>{Math.round(lo * 100)}%</span><span className="cloze-heat-ramp" /><span>{Math.round(hi * 100)}%</span></div>
    </div>
  );
}

/** Heatmap of every practised rule, and the sortable table by rule or by grammar type (click a bar or a cell for the accuracy over time) */
export function ClozeRules({ data }: { data: ClozeAnalyticsData }) {
  const [grouped, setGrouped] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "accuracy", dir: 1 });
  const [open, setOpen] = useState<RuleRow | null>(null);
  const rules = useMemo(() => rowsOf(data, false), [data]);
  const rows = useMemo(() => (grouped ? rowsOf(data, true) : rules), [data, grouped, rules]);
  const sorted = useMemo(() => {
    const val = (r: RuleRow): number | string => (sort.key === "name" ? r.name : sort.key === "answered" ? r.answered : sort.key === "slips" ? r.answered - r.correct : r.accuracy);
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      const c = typeof x === "string" ? x.localeCompare(y as string) : x === y ? 0 : x < (y as number) ? -1 : 1;
      return c * sort.dir || b.answered - a.answered || a.name.localeCompare(b.name);
    });
  }, [rows, sort]);
  const th = (key: SortKey, label: string) => (
    <th aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" className="th-sort" onClick={() => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }))}>
        {label}<span aria-hidden="true">{sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}</span>
      </button>
    </th>
  );
  return (
    <>
      <section className="card">
        <h2>Accuracy by rule</h2>
        <Heatmap rows={rules} onOpen={setOpen} />
        <p className="muted small">Every rule that came up in this period, grouped by grammar type. Green is the highest accuracy shown and red the lowest (the colours stretch over your actual range); the number is the percent correct. Hover for the rule and how often it was practised, click for the accuracy over time. Faded cells have fewer than 5 answers.</p>
      </section>
      <section className="card">
        <h2 className="cloze-rules-heading">
          By rule ({sort.key === "accuracy" && sort.dir === 1 ? "weakest first" : "sorted by " + (sort.key === "slips" ? "slips" : sort.key)})
          <label className="cloze-group-toggle">
            <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} data-testid="cloze-group-toggle" /> Group by grammar type
          </label>
        </h2>
        <div className="table-wrap" style={{ maxHeight: "26rem", overflowY: "auto" }}>
          <table className="data-table" data-testid="cloze-rules">
            <thead style={{ position: "sticky", top: 0, background: "var(--surface)" }}>
              <tr>{th("name", grouped ? "Grammar type" : "Rule")}{th("answered", "Answers")}{th("slips", "Slips")}{th("accuracy", "Accuracy")}<th /></tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.key}>
                  <td>{r.name}{r.note && <span className="muted small"> · {r.note}</span>}{r.answered < 5 && <span className="muted small"> (few)</span>}</td>
                  <td>{r.answered}</td>
                  <td>{r.answered - r.correct}</td>
                  <td>{pct(r.accuracy)}</td>
                  <td>
                    <button type="button" className="spark-btn" style={{ width: "6rem" }} aria-label={`Show accuracy over time for ${r.name}`} onClick={() => setOpen(r)}>
                      <span className="bar" aria-hidden="true"><span style={{ width: `${r.accuracy * 100}%` }} /></span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">The bar shows the share of correct answers: a full bar is 100%. Click a column heading to sort, click a bar for the accuracy over time. Rules with fewer than 5 answers are marked “few”: read them with care.</p>
      </section>
      {open && <ProgressDialog row={open} labels={data.ruleSeries.labels} onClose={() => setOpen(null)} />}
    </>
  );
}
