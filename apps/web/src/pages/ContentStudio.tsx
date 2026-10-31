import { useCallback, useEffect, useState } from "react";
import { VocabularyStudio } from "./VocabularyStudio";
import { ApiRequestError, createBatchApi, fetchBatch, fetchBatches, fetchCoverage, fetchRevisionContent, fetchContentStock, type BatchItem, type BatchSummary, type Coverage, type ItemStatus } from "../api";

const STATUS_LABEL: Record<ItemStatus, string> = { queued: "Generating", invalid: "Needs agent repair", generated: "Draft", ready_for_review: "Awaiting agent", approved: "Approved", released: "Accepted", flagged: "Flagged", rejected: "Rejected" };
const errorText = (e: unknown) => e instanceof ApiRequestError ? e.message : "Something went wrong.";
export const batchAgentTask = (id: string, category: "grammar" | "vocabulary") => `Complete and publish ${category} replenishment batch ${id}. Read content/agent-workflows/${category}.md and common.md in that directory. Run npm run content:agent -- prepare ${id}, review every item, repair suitable drafts as new revisions and reject unsuitable ones. Use the check and finalize commands in the instructions. Independent review by a separate agent is explicitly requested for every final candidate, especially corrections; do not self-approve. Apply the reviewed results to the local app yourself. Do not ask me to copy JSON or run commands. Preserve lesson selection, dictionary edits and raw attempt history. Reply briefly with accepted, corrected and rejected counts.`;

export function ContentStudio({ initialView = "grammar" }: { initialView?: "grammar" | "vocabulary" } = {}) {
  const [category, setCategory] = useState(initialView);
  return <>
    <div className="segmented page-switch" role="radiogroup" aria-label="Which exercises">
      {(["grammar", "vocabulary"] as const).map(c => <label key={c} className={category === c ? "on" : ""}><input type="radio" name="cs-view" checked={category === c} onChange={() => setCategory(c)} data-testid={`studio-${c}`} />{c === "grammar" ? "Grammar exercises" : "Vocabulary exercises"}</label>)}
    </div>
    <BatchStudio key={category} category={category} onCategoryChange={setCategory} />
  </>;
}
function BatchStudio({ category, onCategoryChange }: { category: "grammar" | "vocabulary"; onCategoryChange: (category: "grammar" | "vocabulary") => void }) {
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [otherCount, setOtherCount] = useState(0);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [stock, setStock] = useState<Awaited<ReturnType<typeof fetchContentStock>> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [count, setCount] = useState(50);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [b, c, s] = await Promise.all([fetchBatches(), fetchCoverage(), fetchContentStock()]);
      setBatches(b.batches.filter(b => (b.category ?? "grammar") === category)); setOtherCount(b.batches.filter(b => (b.category ?? "grammar") !== category).length); setCoverage(c); setStock(s);
    } catch(e) { setError(errorText(e)); }
  }, [category]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 5000); return () => clearInterval(t); }, [load]);
  const start = async () => {
    setBusy(true); setError(null); setNote(null);
    try { const r = await createBatchApi({count, mode: "adaptive", category}); setOpen(r.batchId); setNote(`Started ${r.items} drafts. Progress is shown in AI Tasks and the AI activity panel.`); await load(); }
    catch(e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const low = stock?.[category];
  return <>
    <section className="card">
      <h2>Content Studio</h2>
      <p className="lede">Create new {category === "grammar" ? "exercises for your learning skills" : "exercises using your saved words"}. When generation finishes, copy the task to your agent. It checks, repairs and publishes the results for you.</p>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {note && <p className="notice notice-info" role="status">{note}</p>}
      <div className="actions"><label className="inline"><span>Batch size</span><input type="number" min={1} max={500} value={count} onChange={e => setCount(Number(e.target.value))} aria-label="Batch size" /></label><button className="btn btn-primary" disabled={busy || !Number.isInteger(count) || count < 1 || count > 500} onClick={() => void start()}>Start batch</button></div>
    </section>
    <section className="card"><h2>Batches</h2>
      {otherCount > 0 && <p className="small muted">Showing {category} batches. <button className="link" onClick={() => onCategoryChange(category === "grammar" ? "vocabulary" : "grammar")}>Show {otherCount} {category === "grammar" ? "vocabulary" : "grammar"} {otherCount === 1 ? "batch" : "batches"}</button></p>}
      {batches.length === 0 ? <p className="muted">No batches yet. Choose a number and start a batch.</p> : <ul className="batch-list" data-testid="batches">{batches.map(b => <li key={b.id}>
        <button className={`batch-row${open === b.id ? " batch-row-on" : ""}`} onClick={() => setOpen(open === b.id ? null : b.id)} aria-expanded={open === b.id}>
          <span><strong>{category === "grammar" ? "Grammar" : "Vocabulary"} batch · {b.requestedCount} items</strong> <span className="muted small">#{b.id.slice(0,8)} | {new Date(b.createdAt).toLocaleDateString()}</span></span>
          <span className="chips">{Object.entries(b.counts).filter(([,n]) => n > 0).map(([s,n]) => <span key={s} className="chip">{n} {STATUS_LABEL[s as ItemStatus].toLowerCase()}</span>)}</span>
        </button>
        {open === b.id && <BatchDetail id={b.id} category={category} />}
      </li>)}</ul>}
    </section>
    <section className="card"><h2>Coverage</h2>
      {low && <p className={`notice ${low.low ? "notice-error" : "notice-info"}`} role="status">{low.available} new approved exercises available.{low.low ? ` Stock is running low (warning below ${low.threshold}). Create a new batch.` : ""}</p>}
      {category === "vocabulary" ? <VocabularyStudio /> : coverage && <><p>{coverage.totals.releasedExercises} published grammar exercises in total. Used sentences are excluded from available stock.</p><details><summary>Coverage by skill</summary><ul className="small">{coverage.skills.map(s => <li key={s.skill}><code>{s.skill}</code>: {s.released} published, {s.inReview} awaiting agent</li>)}</ul></details></>}
    </section>
  </>;
}
function BatchDetail({ id, category }: { id: string; category: "grammar" | "vocabulary" }) {
  const [data, setData] = useState<(BatchSummary & { items: BatchItem[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { const load = async () => { try {setData(await fetchBatch(id));} catch(e) {setError(errorText(e));} }; void load(); const t = setInterval(() => void load(), 4000); return () => clearInterval(t); }, [id]);
  const task = batchAgentTask(id, category);
  const copy = async () => { try { await navigator.clipboard.writeText(task); setCopied(true); } catch { setError("Clipboard unavailable. Select and copy the task below."); } };
  return <div className="batch-detail" data-testid="batch-detail">
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    {!data ? <p>Loading?</p> : data.completion ? <p className="notice notice-info" role="status">Completed: {data.completion.accepted} accepted, {data.completion.corrected} revised, {data.completion.rejected} rejected{data.completion.flagged ? `, ${data.completion.flagged} flagged` : ""}. Accepted exercises are available for practice.</p> : data.generationDone ? <>
      <h3>Task for the reviewing agent</h3><p className="small muted">This task is for {data.requestedCount} {category} items in batch #{id.slice(0,8)}. The agent checks every item, including generation failures, and publishes accepted exercises.</p>
      <textarea readOnly rows={4} value={task} aria-label="Task for the reviewing agent" onFocus={e => e.currentTarget.select()} />
      <button className="btn btn-primary" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
    </> : <p role="status">Generating drafts? Follow progress in AI Tasks. The reviewing task appears when generation finishes.</p>}
    {data && <details><summary>Item details ({data.requestedCount})</summary><table className="summary-table"><thead><tr><th>#</th><th>Skill / word</th><th>Status</th><th /></tr></thead><tbody>{data.items.map(i => <ItemRow key={i.ordinal} item={i} />)}</tbody></table></details>}
  </div>;
}
function ItemRow({item}: {item: BatchItem}) {
  const [content, setContent] = useState<Record<string, unknown> | null>(null);
  const [open,setOpen] = useState(false);
  const [error,setError] = useState<string | null>(null);
  const toggle = async () => { setOpen(!open); if (!open && item.revisionId && !content) {try {setContent((await fetchRevisionContent(item.revisionId)).content);} catch(e) {setError(errorText(e));}} };
  return <><tr><td>{item.ordinal+1}</td><td>{item.plan.vocabulary?.lemma ?? item.plan.target_skill}</td><td>{STATUS_LABEL[item.status]}</td><td><button className="link" onClick={() => void toggle()}>{open ? "Hide" : "View"}</button></td></tr>{open && <tr><td colSpan={4}>{error ? <p>{error}</p> : content ? <Preview c={content} /> : item.error ? <p className="muted">Generation did not produce a valid draft. The agent can replace or reject this item.</p> : <p>Loading?</p>}</td></tr>}</>;
}
function Preview({ c }: { c: Record<string, unknown> }) {
  const p = c.payload as Record<string, any>;
  const type = c.type as string;
  return (
    <div className="preview small">
      <p><strong>{String(c.prompt_en)}</strong></p>
      {(type === "choose_form" || type === "choose_missing_fragment") && (
        <ul>{(p.options as Array<{ id: string; text: string }>).map((o) => <li key={o.id}>{(p.accepted_option_ids as string[]).includes(o.id) ? "✔ " : ""}{o.text}</li>)}</ul>
      )}
      {type === "detect_error" && <p>{p.sentence} {p.no_mistake ? <em>(no mistake)</em> : <>→ {(p.corrections as string[]).join(" / ")}</>}</p>}
      {(type === "guided_short_answer" || type === "russian_to_english_short") && (
        <>
          <p className="ru">{p.cue_ru}</p>
          <ul>{(p.accepted_answers as string[]).map((a, k) => <li key={k}>{a}</li>)}</ul>
        </>
      )}
      {type === "context_reading" && (
        <>
          {(p.paragraphs as string[]).map((t, k) => <p key={k} className="passage">{t}</p>)}
          {(p.questions as Array<{ prompt: string; options: Array<{ id: string; text: string }>; accepted_option_ids: string[] }>).map((q, k) => (
            <div key={k}><p>{q.prompt}</p><ul>{q.options.map((o) => <li key={o.id}>{q.accepted_option_ids.includes(o.id) ? "✔ " : ""}{o.text}</li>)}</ul></div>
          ))}
        </>
      )}
      <p className="ru muted">{String((c.hints_ru as string[])[0] ?? "")}</p>
      <p className="ru">{String(c.explanation_ru)}</p>
    </div>
  );
}
