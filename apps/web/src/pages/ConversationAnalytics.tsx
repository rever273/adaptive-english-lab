import { useEffect, useState } from "react";
import { Chart } from "../components/Chart";
import { LineChart } from "../components/LineChart";
import * as api from "../api";
import { fmtDuration } from "../format";

const time = fmtDuration;
const CEFR = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
/** fixed categorical order for the dark surface (validated) */
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"] as const;
const LEVEL = { ok: { label: "Looks good", color: "#0ca30c" }, tip: { label: "Could sound more natural", color: "#fab219" }, error: { label: "Mistake", color: "#d03b3b" } } as const;
const ISSUE: Record<keyof api.ConversationInsights["issues"], string> = { grammar: "Grammar", vocabulary: "Word choice", spelling: "Spelling", word_order: "Word order", naturalness: "Naturalness" };
const day = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short" });

/** share of answers judged ok / tip / mistake, one split bar per conversation (latest at the bottom) */
function QualityBars({ list }: { list: api.ConversationInsights["perConversation"] }) {
  const rows = list.filter((c) => c.levels.ok + c.levels.tip + c.levels.error > 0).slice(-12);
  if (rows.length === 0) return <p className="muted">No AI feedback on these answers yet.</p>;
  return (
    <div className="cv-quality">
      <div className="cl-legend">
        {(Object.keys(LEVEL) as Array<keyof typeof LEVEL>).map((k) => <span key={k}><span className="cl-sw" style={{ background: LEVEL[k].color }} /> {LEVEL[k].label}</span>)}
      </div>
      <ul role="list">
        {rows.map((c, i) => {
          const n = c.levels.ok + c.levels.tip + c.levels.error;
          return (
            <li key={`${c.startedAt}-${i}`} title={`${c.topic}: ${c.levels.ok} good, ${c.levels.tip} tips, ${c.levels.error} mistakes`}>
              <span className="cv-q-name"><span className="muted small">{day(c.startedAt)}</span> {c.topic}</span>
              <span className="cv-q-bar" aria-hidden="true">
                {(Object.keys(LEVEL) as Array<keyof typeof LEVEL>).map((k) => c.levels[k] > 0 && <span key={k} style={{ width: `${(c.levels[k] / n) * 100}%`, background: LEVEL[k].color }} />)}
              </span>
              <span className="num small">{Math.round((c.levels.ok / n) * 100)}%</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** horizontal count bars (kinds of problems, grammar points) */
function CountBars({ items, color }: { items: Array<{ key: string; label: string; count: number }>; color: string }) {
  const shown = items.filter((x) => x.count > 0);
  if (shown.length === 0) return <p className="muted">Nothing to show yet.</p>;
  const max = Math.max(...shown.map((x) => x.count));
  return (
    <ul className="time-top" role="list">
      {shown.map((x) => (
        <li key={x.key}>
          <span className="time-top-word" title={x.label}>{x.label}</span>
          <span className="mode-bar"><span style={{ width: `${(x.count / max) * 100}%`, background: color }} /></span>
          <span className="num small">{x.count}</span>
        </li>
      ))}
    </ul>
  );
}

export function ConversationAnalytics({ days }: { days: "7" | "30" | "90" | "all" }) {
  const [data, setData] = useState<api.ConversationAnalyticsData | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => { let live = true; setData(null); setError(false); void api.fetchConversationAnalytics(days).then(d => { if (live) setData(d); }).catch(() => { if (live) setError(true); }); return () => { live = false; }; }, [days]);
  const ins = data?.insights;
  const per = ins?.perConversation ?? [];
  const labels = per.map((c) => day(c.startedAt));
  const tips = per.map((c) => `${new Date(c.startedAt).toLocaleString("en-AU")} · ${c.topic}`);
  const judged = ins ? ins.levels.ok + ins.levels.tip + ins.levels.error : 0;
  const cefrJudged = ins ? CEFR.reduce((n, k) => n + ins.cefr[k], 0) : 0;
  return <section className="card" data-testid="conversation-analytics"><h2><i className="pi pi-comments" /> Conversation analytics</h2>
    {error ? <p role="alert">Could not load conversation analytics.</p> : !data || !ins ? <p>Loading…</p> : <>
      <p className="muted small">Conversations started in the selected period, including their full recorded duration and answers.</p>
      <div className="stat-grid-2 vocab-analytics-stats">
        {([
          ["pi-comments", "Conversations", data.conversations],
          ["pi-send", "Your answers", data.answers],
          ["pi-clock", "Active time", time(data.activeMs)],
          ["pi-align-left", "Words you wrote", ins.totalWords],
          ["pi-sparkles", "Different words", ins.distinctWords],
          ["pi-chart-bar", "Words per answer", ins.wordsPerAnswer === null ? "—" : ins.wordsPerAnswer.toFixed(1)],
          ["pi-bookmark", "Your saved words used", `${ins.savedWordsUsed} of ${ins.savedWords}`],
          ["pi-check-circle", "AI: looks good", judged ? `${Math.round((ins.levels.ok / judged) * 100)}%` : "—"],
        ] as const).map(([icon, label, value]) => <div className="stat stat-info" key={label}><i className={`pi ${icon}`} aria-hidden="true" /><span className="stat-value">{value}</span><span className="stat-label">{label}</span></div>)}
      </div>
      <p className="muted small">AI figures are tentative local-model judgements of whole answers; they never affect Mastery. They cover {data.availableAnswers} retained answers; deleted text and older plain feedback are left out.</p>

      {data.series.length > 0 && <>
        <h3>Conversation activity</h3>
        <Chart ariaLabel="Answers per conversation" bars={{color:"#3987e5",format:v => `${Math.round(v)}`}} points={data.series.map((s,i) => ({key:`${s.startedAt}-${i}`,label:day(s.startedAt),bar:s.answers,tip:[new Date(s.startedAt).toLocaleString("en-AU"),`${s.answers} answers`,`Active time: ${time(s.activeMs)}`]}))} legend="Answers per conversation, placed at its start date; the tooltip shows the active time." />
      </>}

      <div className="charts-grid">
        <div><h3>Answer quality <span className="muted small">(local AI, tentative)</span></h3><QualityBars list={per} /></div>
        <div><h3>How much you write</h3>
          {per.length === 0 ? <p className="muted">No retained answers yet.</p> : <LineChart ariaLabel="Words per answer and longest answer per conversation" labels={labels} tips={tips} series={[
            { key: "avg", name: "Words per answer", color: SERIES[0], values: per.map((c) => c.wordsPerAnswer === null ? null : Math.round(c.wordsPerAnswer * 10) / 10) },
            { key: "long", name: "Longest answer", color: SERIES[1], values: per.map((c) => c.longest), dashed: true },
          ]} format={(v) => `${Math.round(v)}`} note="Longer, fuller answers are a sign of growing confidence." />}
        </div>
      </div>

      <div className="charts-grid">
        <div><h3>Level your answers show <span className="muted small">(local AI estimate)</span></h3>
          {cefrJudged === 0 ? <p className="muted">No estimates yet: they are made for new answers of five words or more.</p> : <>
            <LineChart ariaLabel="Estimated CEFR level per conversation" labels={labels} tips={tips} series={[{ key: "cefr", name: "Estimated level", color: SERIES[2], values: per.map((c) => c.cefr) }]} max={6} format={(v) => CEFR[Math.max(0, Math.round(v) - 1)] ?? ""} />
            <Chart ariaLabel="Answers by estimated CEFR level" height={170} bars={{ color: SERIES[2], format: (v) => `${Math.round(v)}` }} points={CEFR.map((k) => ({ key: k, label: k, bar: ins.cefr[k], tip: [k, `${ins.cefr[k]} answer(s)`] }))} legend="Answers by the level their vocabulary and structures show (median per conversation above). An estimate, not a test." />
          </>}
        </div>
        <div><h3>Time to answer</h3>
          {per.every((c) => c.replyMedianMs === null) ? <p className="muted">Not enough timed answers yet.</p> : <LineChart ariaLabel="Median time to answer per conversation" labels={labels} tips={tips} series={[{ key: "reply", name: "Median time to answer", color: SERIES[3], values: per.map((c) => c.replyMedianMs === null ? null : Math.round(c.replyMedianMs / 100) / 10) }]} format={(v) => `${Math.round(v)} s`} note="From the partner's message to your answer (pauses over 10 minutes left out). Shorter usually means more fluent." />}
          <h3>Words you use</h3>
          {per.length === 0 ? null : <LineChart ariaLabel="Different words and saved words used per conversation" labels={labels} tips={tips} series={[
            { key: "distinct", name: "Different words", color: SERIES[0], values: per.map((c) => c.distinctWords) },
            { key: "saved", name: "Saved words used", color: SERIES[4], values: per.map((c) => c.savedWordsUsed) },
          ]} />}
        </div>
      </div>

      <div className="charts-grid">
        <div><h3>Kinds of problems <span className="muted small">(answers with a tip or a mistake)</span></h3>
          <CountBars color="#d95926" items={(Object.keys(ISSUE) as Array<keyof typeof ISSUE>).map((k) => ({ key: k, label: ISSUE[k], count: ins.issues[k] }))} />
        </div>
        <div><h3>Grammar points behind mistakes</h3>
          <CountBars color="#d03b3b" items={ins.skills.map((s) => ({ key: s.id, label: s.label, count: s.count }))} />
        </div>
      </div>

      <h3>Recent conversations</h3>
      {data.sessions.length === 0 ? <p>No conversations in this period yet.</p> : <div className="table-wrap"><table className="data-table"><thead><tr><th>Topic</th><th>Started</th><th>Answers</th><th>Active time</th></tr></thead><tbody>{data.sessions.map((s,i) => <tr key={`${s.startedAt}-${i}`}><td><strong>{s.topic}</strong>{!!s.historyDeleted && <span className="muted small"> · text deleted</span>}</td><td>{new Date(s.startedAt).toLocaleDateString("en-AU")}</td><td className="num">{s.answers}</td><td className="num">{time(s.activeMs)}</td></tr>)}</tbody></table></div>}
    </>}
  </section>;
}
