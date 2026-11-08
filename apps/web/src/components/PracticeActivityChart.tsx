import { useEffect, useState } from "react";
import { fetchPracticeActivity } from "../api";
import { Chart } from "./Chart";

type Days = "7" | "30" | "90" | "all";
export function PracticeActivityChart({ mode, days }: { mode: "grammar" | "vocabulary"; days: Days }) {
  const [rows, setRows] = useState<Array<{ date: string; grammar: number; vocabulary: number }> | null>(null);
  const [error, setError] = useState(false);
  const [results, setResults] = useState<Array<{date:string;correct:number;scored:number;skills:number}>>([]);
  useEffect(() => { let active = true; fetchPracticeActivity().then((r) => { if (active) { setRows(r.days); setResults(r.grammarResults); } }).catch(() => { if (active) setError(true); }); return () => { active = false; }; }, []);
  if (error) return <p className="muted">Practice time is unavailable.</p>;
  if (!rows) return <p className="muted">Loading practice time...</p>;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Brisbane", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() - 3600000));
  const first = days === "all" ? [rows[0]?.date, mode === "grammar" ? results[0]?.date : undefined].filter((d): d is string => !!d).sort()[0] : new Date(Date.parse(today + "T00:00:00Z") - (Number(days) - 1) * 86400000).toISOString().slice(0,10);
  if (!first) return <p className="muted">No recorded practice time yet.</p>;
  const byDate = new Map(rows.map((r) => [r.date, r[mode]]));
  const points = []; for (let at = Date.parse(first + "T00:00:00Z"), end = Date.parse(today + "T00:00:00Z"); at <= end; at += 86400000) { const date = new Date(at).toISOString().slice(0,10); const minutes = (byDate.get(date) ?? 0) / 60000; points.push({ key: date, label: date.slice(5), bar: minutes, tip: [date, `Practice: ${minutes.toFixed(1)} min`] }); }
  const byResult = new Map(results.map((r) => [r.date, r]));
  return <div><h3>Practice time per day</h3><Chart ariaLabel={`${mode} practice time per day`} bars={{ color: "#b78bff", format: (v) => `${Math.round(v)} min` }} points={points} legend="Recorded active time; learning day starts at 1 am Brisbane time. Older activity before time recording is unavailable." />
  {mode === "grammar" && <><h3>Independent results per day</h3><Chart ariaLabel="Correct first answers and grammar skills per day" bars={{ color: "#51b788", format: (v) => `${Math.round(v)}` }} line={{ color: "#6ab7ff", format: (v) => `${Math.round(v)}` }} legend="Bars: confirmed correct first answers without help; line: distinct skills assessed that day. Labelled repeats are excluded." points={points.map((p) => { const r = byResult.get(p.key); return { ...p, bar: r?.correct ?? 0, line: r?.skills ?? 0, tip: [p.key, `Correct: ${r?.correct ?? 0} of ${r?.scored ?? 0}`, `Skills: ${r?.skills ?? 0}`] }; })} /></>}
  </div>;
}
