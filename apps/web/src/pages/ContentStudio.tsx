import { useCallback, useEffect, useState } from "react";
import { VocabularyStudio } from "./VocabularyStudio";
import { batchCache, coverageCache, stockCache } from "./studioCache";
import { ApiRequestError, createBatchApi, fetchBatch, fetchRevisionContent, fetchContentStock, type BatchItem, type BatchSummary, type StudioBatchSummary, type Coverage, type ItemStatus } from "../api";

const STATUS_LABEL: Record<ItemStatus, string> = { queued: "Generating", invalid: "Needs agent repair", generated: "Draft", ready_for_review: "Awaiting agent", approved: "Approved", released: "Accepted", flagged: "Flagged", rejected: "Rejected" };
const errorText = (e: unknown) => e instanceof ApiRequestError ? e.message : "Something went wrong.";
export const batchAgentTask = (id: string, category: "grammar" | "vocabulary") => `Complete and publish ${category} replenishment batch ${id}. Read content/agent-workflows/${category}.md and common.md in that directory. Run npm run content:agent -- prepare ${id}, review every item, repair suitable drafts as new revisions and reject unsuitable ones. Use the check and finalize commands in the instructions. Independent review by a separate agent is explicitly requested for every final candidate, especially corrections; do not self-approve. Do the review through the content-reviewer agent and the tools in .claude/tools (see your project memory for the workflow), after you have rejected duplicates and fixed the known defects yourself. Apply the reviewed results to the local app yourself. Do not ask me to copy JSON or run commands. Preserve lesson selection, dictionary edits and raw attempt history. Reply briefly with accepted, corrected and rejected counts, and end with one short line: how many tokens the review subagent(s) used in total.`;

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
  const [batches, setBatches] = useState<StudioBatchSummary[]>(() => (batchCache.peek()?.batches ?? []).filter(b => (b.category ?? "grammar") === category));
  const [otherCount, setOtherCount] = useState(() => (batchCache.peek()?.batches ?? []).filter(b => (b.category ?? "grammar") !== category).length);
  const [coverage, setCoverage] = useState<Coverage | null>(() => coverageCache.peek());
  const [stock, setStock] = useState<Awaited<ReturnType<typeof fetchContentStock>> | null>(() => stockCache.peek());
  const [open, setOpen] = useState<string | null>(null);
  const [count, setCount] = useState(50);
  const [countTouched, setCountTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const loadBatches = useCallback(async (force = false) => {
    try {
      const b = await batchCache.get(force);
      setBatches(b.batches.filter(b => (b.category ?? "grammar") === category));
      setOtherCount(b.batches.filter(b => (b.category ?? "grammar") !== category).length);
    } catch (e) { setError(errorText(e)); }
  }, [category]);
  const loadCoverage = useCallback(async (force = false) => {
    try {
      const c = await coverageCache.get(force); setCoverage(c);
      const s = await stockCache.get(force); setStock(s);
      const rec = s[category].recommended; if (!countTouched && rec && rec > 0) setCount(Math.min(500, rec));
    } catch (e) { setError(errorText(e)); }
  }, [category, countTouched]);
  useEffect(() => {
    let active = true;
    void loadBatches().then(() => { if (active) void loadCoverage(); });
    const listTimer = setInterval(() => void loadBatches(true), 5000);
    const coverageTimer = setInterval(() => void loadCoverage(true), 30000);
    return () => { active = false; clearInterval(listTimer); clearInterval(coverageTimer); };
  }, [loadBatches, loadCoverage]);
  const start = async () => {
    setBusy(true); setError(null); setNote(null);
    try { const r = await createBatchApi({count, mode: "adaptive", category}); setOpen(r.batchId); setNote(`Started ${r.items} drafts. Progress is shown in AI Tasks and the AI activity panel.`); await batchCache.get(); await loadBatches(true); }
    catch(e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const low = stock?.[category];
  const course = category === "grammar" ? stock?.grammar.course : undefined;
  const calculateCourse = async () => {
    setBusy(true); setError(null);
    try {
      const fresh = await stockCache.get(true); setStock(fresh);
      const estimate = fresh.grammar.course;
      if (!estimate) { setNote("No available lessons to plan."); return; }
      setCountTouched(true);
      if (estimate.recommended > 0) setCount(Math.min(500, estimate.recommended));
      setNote(estimate.recommended === 0 ? "No estimated deficit for the lessons." : `Estimated ${estimate.recommended} drafts for ${estimate.lessons} lessons, including 20% margin.${estimate.recommended > 500 ? " One batch can contain up to 500; create another after review and recalculate." : ""}`);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const vocabularyPlan = category === "vocabulary" ? stock?.vocabulary.plan : undefined;
  const calculateVocabulary = async () => {
    setBusy(true); setError(null);
    try {
      const fresh = await stockCache.get(true); setStock(fresh);
      const estimate = fresh.vocabulary.plan;
      if (!estimate || estimate.words === 0) { setNote("Add words to your dictionary first."); return; }
      setCountTouched(true);
      if (estimate.recommended > 0) setCount(Math.min(500, estimate.recommended));
      setNote(estimate.recommended === 0 ? "All words have the planned stock of contexts." : `Estimated ${estimate.recommended} drafts for ${estimate.words} words, including 20% margin.${estimate.recommended > 500 ? " One batch can contain up to 500; review it and recalculate before the next batch." : ""}`);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const batchRow = (b: StudioBatchSummary) => <li key={b.id}>
    <button className={`batch-row${open === b.id ? " batch-row-on" : ""}`} onClick={() => setOpen(open === b.id ? null : b.id)} aria-expanded={open === b.id}>
      <span><strong>{category === "grammar" ? "Grammar" : "Vocabulary"} batch | {b.requestedCount} items</strong> <span className="muted small">#{b.id.slice(0,8)} | {new Date(b.createdAt).toLocaleDateString()}</span></span>
      <span className="chips">{b.completion ? <><span className="chip">Completed</span><span className="chip chip-released">{b.completion.accepted} accepted</span><span className="chip chip-rejected">{b.completion.rejected} rejected</span>{b.completion.flagged > 0 && <span className="chip chip-flagged">{b.completion.flagged} flagged</span>}</> : Object.entries(b.counts ?? {}).filter(([,n]) => n > 0).map(([status,n]) => <span key={status} className={`chip chip-${status}`}>{n} {STATUS_LABEL[status as ItemStatus].toLowerCase()}</span>)}</span>
    </button>
    {open === b.id && (b.completion ? <div className="batch-detail"><p className="notice notice-info" role="status">Completed: {b.completion.accepted} accepted, {b.completion.corrected} revised, {b.completion.rejected} rejected{b.completion.flagged ? `, ${b.completion.flagged} flagged` : ""}.</p></div> : <BatchDetail id={b.id} category={category} />)}
  </li>;
  return <>
    <section className="card">
      <h2>Content Studio</h2>
      <p className="lede">Create new {category === "grammar" ? "exercises for your learning skills" : "exercises using your saved words"}. When generation finishes, copy the task to your agent. It checks, repairs and publishes the results for you.</p>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {note && <p className="notice notice-info" role="status">{note}</p>}
      <div className="actions"><label className="inline"><span>Batch size</span><input type="number" min={1} max={500} value={count} onChange={e => { setCountTouched(true); setCount(Number(e.target.value)); }} aria-label="Batch size" /></label><button className="btn btn-primary" disabled={busy || !Number.isInteger(count) || count < 1 || count > 500} onClick={() => void start()}>Start batch</button>{category === "grammar" ? <button className="btn" disabled={busy} onClick={() => void calculateCourse()}>Calculate for lessons</button> : <button className="btn" disabled={busy} onClick={() => void calculateVocabulary()}>Calculate for words</button>}</div>
    </section>
    <section className="card"><h2>Batches</h2>
      {otherCount > 0 && <p className="small muted">Showing {category} batches. <button className="link" onClick={() => onCategoryChange(category === "grammar" ? "vocabulary" : "grammar")}>Show {otherCount} {category === "grammar" ? "vocabulary" : "grammar"} {otherCount === 1 ? "batch" : "batches"}</button></p>}
      {batches.length === 0 ? <p className="muted">No batches yet. Choose a number and start a batch.</p> : <>
        <ul className="batch-list" data-testid="batches">{batches.slice(0, 5).map(batchRow)}</ul>
        {batches.length > 5 && <details className="older-batches">
          <summary>Earlier batches ({batches.length - 5})</summary>
          <div className="older-batches-scroll"><ul className="batch-list">{batches.slice(5).map(batchRow)}</ul></div>
        </details>}
      </>}

    </section>
    <section className="card"><h2>Coverage</h2>
      {low && <p className={`notice ${low.low ? "notice-error" : "notice-info"}`} role="status">{low.message ?? `${low.available} new approved exercises available.${low.low ? ` Stock is running low (warning below ${low.threshold}). Create a new batch.` : ""}`}{low.recommended ? ` Suggested batch size: ${low.recommended} (deficit + 20%).` : ""}</p>}
      {vocabularyPlan && <p className="small" role="status">{vocabularyPlan.words} words: {vocabularyPlan.deficit} contexts missing; {vocabularyPlan.recommended} drafts suggested with 20% margin. Target: {vocabularyPlan.targetPerWord} approved contexts per word (2 recognition, 2 recall, 1 collocation). Previously seen contexts count as reusable; drafts do not count until approved. Recalculate after review.</p>}
      {course && <p className="small" role="status">All lessons: estimated {course.deficit} exercises short; {course.recommended} drafts suggested with 20% margin for {course.sessionsPerLesson} sessions per lesson. Based on approved stock only; pending drafts may be rejected. Shared exercises and future repeats make this an estimate, not a guarantee. Recalculate after review.</p>}
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
  return <><tr><td>{item.ordinal+1}</td><td>{item.plan.vocabulary?.lemma ?? item.plan.target_skill}{item.plan.lesson ? <span className="muted small"> · {/l(\d+)$/i.test(item.plan.lesson) ? `L${/l(\d+)$/i.exec(item.plan.lesson)![1]!.padStart(2, "0")}` : item.plan.lesson}</span> : null}</td><td>{STATUS_LABEL[item.status]}</td><td><button className="link" onClick={() => void toggle()}>{open ? "Hide" : "View"}</button></td></tr>{open && <tr><td colSpan={4}>{error ? <p>{error}</p> : content ? <Preview c={content} /> : item.error ? <p className="muted">Generation did not produce a valid draft. The agent can replace or reject this item.</p> : <p>Loading?</p>}</td></tr>}</>;
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
