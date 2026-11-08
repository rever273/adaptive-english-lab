import { useEffect, useState } from "react";
import { Chart } from "../components/Chart";
import * as api from "../api";

const time = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
export function ConversationAnalytics({ days }: { days: "7" | "30" | "90" | "all" }) {
  const [data, setData] = useState<api.ConversationAnalyticsData | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => { let live = true; setData(null); setError(false); void api.fetchConversationAnalytics(days).then(d => { if (live) setData(d); }).catch(() => { if (live) setError(true); }); return () => { live = false; }; }, [days]);
  return <section className="card" data-testid="conversation-analytics"><h2><i className="pi pi-comments" /> Conversation analytics</h2>
    {error ? <p role="alert">Could not load conversation analytics.</p> : !data ? <p>Loading…</p> : <>
      <p className="muted small">Conversations started in the selected period, including their full recorded duration and answers.</p>
      <div className="stat-grid-2 vocab-analytics-stats">
        {[["Conversations",data.conversations],["Your answers",data.answers],["Active time",time(data.activeMs)],["Average per conversation",time(data.conversations ? data.activeMs / data.conversations : 0)],["Your sentences (approx.)",data.sentences],["AI: looks good",data.good],["AI: suggestions",data.suggestions],["Unclassified answers",data.unclassified]].map(([label,value]) => <div className="stat stat-info" key={label}><span className="stat-value">{value}</span><span className="stat-label">{label}</span></div>)}
      </div>
      <p className="muted small">AI feedback is tentative, applies to whole answers and does not affect Mastery. Sentence counts and feedback cover {data.availableAnswers} retained answers; deleted text and older unstructured feedback cannot be fully analysed.</p>
      {data.series.length > 0 && <>
        <h3>Conversation activity</h3>
        <Chart ariaLabel="Answers and active time per conversation" bars={{color:"#6ca9ff",format:v => `${Math.round(v)}`}} line={{color:"#f3c94d",format:v => `${Math.round(v)} min`}} points={data.series.map((s,i) => ({key:`${s.startedAt}-${i}`,label:new Date(s.startedAt).toLocaleDateString("en-AU",{day:"numeric",month:"short"}),bar:s.answers,line:s.activeMs / 60000,tip:[new Date(s.startedAt).toLocaleString("en-AU"),`${s.answers} answers`,`Active time: ${time(s.activeMs)}`]}))} legend="Blue bars: answers · yellow line: active minutes. Each point represents one conversation, placed at its start date; resumed activity is included in its total." />
        <h3>AI feedback</h3>
        {data.good + data.suggestions > 0 ? <Chart ariaLabel="Tentative AI feedback per conversation" bars={{color:"#3fbf6f",format:v => `${Math.round(v)}`}} bars2={{color:"#ef7777",format:v => `${Math.round(v)}`}} points={data.series.map((s,i) => ({key:`${s.startedAt}-${i}`,label:new Date(s.startedAt).toLocaleDateString("en-AU",{day:"numeric",month:"short"}),bar:s.good,bar2:s.suggestions,tip:[new Date(s.startedAt).toLocaleString("en-AU"),`Looks good: ${s.good}`,`Suggestions: ${s.suggestions}`]}))} legend="Green: looks good · red: suggestions. Tentative AI feedback on retained answers, not confirmed grades." /> : <p className="muted">No structured AI feedback available for these conversations yet.</p>}
      </>}
      <h3>Recent conversations</h3>
      {data.sessions.length === 0 ? <p>No conversations in this period yet.</p> : <div className="table-wrap"><table className="data-table"><thead><tr><th>Topic</th><th>Started</th><th>Answers</th><th>Active time</th></tr></thead><tbody>{data.sessions.map((s,i) => <tr key={`${s.startedAt}-${i}`}><td><strong>{s.topic}</strong>{!!s.historyDeleted && <span className="muted small"> · text deleted</span>}</td><td>{new Date(s.startedAt).toLocaleDateString("en-AU")}</td><td className="num">{s.answers}</td><td className="num">{time(s.activeMs)}</td></tr>)}</tbody></table></div>}
    </>}
  </section>;
}

