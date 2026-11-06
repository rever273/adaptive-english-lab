import { useCallback, useEffect, useState } from "react";
import { VocabularyStudio } from "./VocabularyStudio";
import { batchCache, coverageCache, stockCache } from "./studioCache";
import { ApiRequestError, createBatchApi, createAgentBatchApi, createThoughtBatchApi, fetchThoughts, fetchBatch, fetchRevisionContent, fetchContentStock, fetchTypingOverview, fetchDictationPool, prepareDictationTracks, type DictationPoolSummary, type BatchItem, type BatchSummary, type StudioBatchSummary, type Coverage, type ItemStatus } from "../api";

const STATUS_LABEL: Record<ItemStatus, string> = { queued: "Generating", invalid: "Needs agent repair", generated: "Draft", ready_for_review: "Awaiting agent", approved: "Approved", released: "Accepted", flagged: "Flagged", rejected: "Rejected" };
const errorText = (e: unknown) => e instanceof ApiRequestError ? e.message : "Something went wrong.";
const THOUGHTS_AGENT_TASK = `English Lab: choose the grammar skills for my saved thoughts. Follow any local project instructions. Work on your own and run every command yourself; do not ask me to run anything. Do not commit or push. Never edit the SQLite database directly; use only the commands below. Keep the thoughts private: do not copy them into Git or public files.
1. Run: npm run lab:thoughts -- export (read-only; it prints where thoughts.md and thoughts.json are).
2. For EVERY pattern pick the ONE skill whose rule the pattern genuinely exercises, judging by the rule text, not the skill id; use null when nothing fits or the pattern is wrong for the sentence. Do not take the nearest-sounding skill.
3. Write the manifest (template in thoughts.json) and apply it: npm run lab:thoughts -- apply <manifest.json>.
4. Reply in Russian, briefly: how many thoughts got skills, how many patterns were dropped and why.`;

export const batchAgentTask = (id: string, category: "grammar" | "vocabulary") => `Complete and publish ${category} replenishment batch ${id}. Read content/agent-workflows/${category}.md and common.md in that directory. Run npm run content:agent -- prepare ${id}, review every item, repair suitable drafts as new revisions and reject unsuitable ones. Use the check and finalize commands in the instructions. Independent review by a separate agent is explicitly requested for every final candidate, especially corrections; do not self-approve. Do the review through the content-reviewer agent and the tools in .claude/tools (see your project memory for the workflow), after you have rejected duplicates and fixed the known defects yourself. Apply the reviewed results to the local app yourself. Do not ask me to copy JSON or run commands. Preserve lesson selection, dictionary edits and raw attempt history. Reply briefly with accepted, corrected and rejected counts, and end with one short line: how many tokens the review subagent(s) used in total.`;

const VIEWS = [["grammar", "Grammar exercises"], ["vocabulary", "Vocabulary exercises"], ["typing", "Typing"]] as const;
/** The agent writes the exercises itself: the batch is stored (no local model runs) and this task tells it exactly what to do. */
export const authoringAgentTask = (id: string, count: number, category: "grammar" | "vocabulary" = "vocabulary") => `Write and publish ${category} batch ${id} (${count} items) yourself; no local model is used. Read content/agent-workflows/${category}.md and common.md in that directory, then run npm run content:agent -- prepare ${id} and read author-packet.json in the reported work directory (${category === "vocabulary" ? "the planned words, families, CEFR levels, topic ideas, meanings, synonyms, sentences to avoid and wrong-option candidates" : "the planned skills with their rule cards, formats, CEFR levels and topics, plus the draft format of every exercise type"} are ready there). Plan the items of one ${category === "vocabulary" ? "word" : "skill"} together so each has its own scene, people and sentence type: the author command rejects repeated frames. Write one draft per item into drafts.json in the format shown in that packet, then run npm run content:agent -- author ${id}; fix every PROBLEM it prints and run it again until none remain. Aim for exercises you would accept yourself: natural Australian English at the item's level, one defensible answer, wrong options that clearly do not fit, accurate Russian. Then set plan.author, run check, have the content-reviewer agent review every final candidate through the tools in .claude/tools (see your project memory), apply its FIX lines as patches and re-review only the changed hashes, then finalize. Do not ask me to copy JSON or run commands. Preserve lesson selection, dictionary edits and raw attempt history. Reply briefly with accepted, corrected and rejected counts, then report tokens separately: the review subagent(s) exactly, and your own work as an estimate (say it is an estimate), so the result can be compared with a locally generated batch.`;

export function ContentStudio({ initialView = "grammar" }: { initialView?: "grammar" | "vocabulary" | "typing" } = {}) {
  const [category, setCategory] = useState(initialView);
  return <>
    <div className="segmented page-switch" role="radiogroup" aria-label="Which exercises">
      {VIEWS.map(([c, label]) => <label key={c} className={category === c ? "on" : ""}><input type="radio" name="cs-view" checked={category === c} onChange={() => setCategory(c)} data-testid={`studio-${c}`} />{label}</label>)}
    </div>
    {category === "typing" ? <DictationTracks /> : <BatchStudio key={category} category={category} onCategoryChange={setCategory} />}
  </>;
}

function DictationTracks() {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof fetchTypingOverview>>["dictation"] | null>(null);
  const [pool, setPool] = useState<DictationPoolSummary | null>(null);
  const [count, setCount] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    void fetchTypingOverview().then((o) => setInfo(o.dictation)).catch(() => undefined);
    void fetchDictationPool().then(setPool).catch(() => undefined);
  }, []);
  useEffect(load, [load]);
  const generating = (info?.pool.generating ?? 0) > 0;
  useEffect(() => {
    if (!generating) return;
    const id = window.setInterval(load, 2500);
    return () => window.clearInterval(id);
  }, [generating, load]);
  const minutes = pool ? Math.floor(pool.audioSeconds / 60) : 0;
  const day = (iso: string) => new Date(iso).toLocaleDateString();
  return <>
    <section className="card"><h2>Audio Dictation tracks</h2>
      <p className="lede">Prepare spoken sentences ahead of time, so Audio Dictation lessons start without waiting. Sentences stay hidden here so the dictation is not spoiled.</p>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {info && !info.available && <p className="notice notice-warning small" role="status">Audio Dictation is not available yet{info.reason ? `: ${info.reason}` : ""}.</p>}
      <div className="dictation-prepare">
        <label className="small">Prepare <input type="number" min={1} max={50} value={count} onChange={(e) => setCount(Math.min(50, Math.max(1, Math.round(Number(e.target.value) || 1))))} aria-label="Number of audio tracks to prepare" data-testid="dictation-prepare-count" /> audio tracks for later</label>
        <button className="btn" disabled={!info?.available} onClick={() => { setError(null); void prepareDictationTracks(count).catch((e) => setError(errorText(e))).finally(load); }} data-testid="dictation-prepare">Prepare</button>
        {info && <p className="muted small" role="status">{info.pool.prepared} ready for the next lessons{info.pool.generating > 0 ? ` · ${info.pool.generating} being prepared` : ""}</p>}
      </div>
    </section>
    <section className="card"><h2>Prepared tracks</h2>
      {!pool || (pool.ready === 0 && pool.used === 0) ? <p className="muted">No prepared tracks yet.</p> : <>
        <p className="small" data-testid="dictation-pool-summary">{pool.ready} ready ({minutes > 0 ? `${minutes} min ` : ""}{pool.audioSeconds % 60} s of audio{pool.ready > 0 ? `, ${pool.minWords}–${pool.maxWords} words each` : ""}); {pool.used} already used in lessons.{pool.oldest ? ` Prepared ${day(pool.oldest)}${pool.newest && day(pool.newest) !== day(pool.oldest) ? ` to ${day(pool.newest)}` : ""}.` : ""}</p>
        {pool.topics.length > 0 && <><h3>Topics ({pool.topicTotal})</h3><p className="chips">{pool.topics.map((t) => <span key={t.topic} className="chip">{t.topic} · {t.n}</span>)}</p>{pool.topicTotal > pool.topics.length && <p className="muted small">The {pool.topics.length} most frequent of {pool.topicTotal} topics are shown; the rest have one or two tracks each.</p>}</>}
        {pool.voices.length > 0 && <><h3>Voices</h3><p className="chips">{pool.voices.map((v) => <span key={v.name} className="chip">{v.name} · {v.n}</span>)}</p></>}
      </>}
    </section>
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
  const [thoughts, setThoughts] = useState({ ready: 0, needSkills: 0 });
  useEffect(() => { void fetchThoughts().then(r => setThoughts({ ready: r.readyForBatch, needSkills: r.needSkills })).catch(() => undefined); }, [note]);
  const copyAgentPrompt = async () => {
    setBusy(true); setError(null); setNote(null);
    try {
      const r = await createAgentBatchApi({ count, mode: "adaptive", category });
      setOpen(r.batchId);
      await navigator.clipboard?.writeText(authoringAgentTask(r.batchId, r.items, category));
      setNote(`Batch #${r.batchId.slice(0, 8)} of ${r.items} exercises is stored for your agent and the task is copied. Paste it to your coding agent.`);
      await batchCache.get(); await loadBatches(true);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const startThoughts = async () => {
    setBusy(true); setError(null); setNote(null);
    try { const r = await createThoughtBatchApi(); setOpen(r.batchId); setNote(`Started ${r.items} drafts from ${r.thoughts} thought${r.thoughts === 1 ? "" : "s"}. They wait for independent review like any other draft.`); await batchCache.get(); await loadBatches(true); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
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
      setNote(estimate.recommended === 0 ? `No missing exercises found for ${estimate.sessions} remaining sessions.` : `Estimated ${estimate.deficit} approved exercises missing for ${estimate.sessions} remaining sessions; ${estimate.recommended} drafts include a 20% review margin.${estimate.recommended > 500 ? " One batch can contain up to 500; create another after review and recalculate." : ""}`);
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
      <div className="actions"><label className="inline"><span>Batch size</span><input type="number" min={1} max={500} value={count} onChange={e => { setCountTouched(true); setCount(Number(e.target.value)); }} aria-label="Batch size" /></label><button className="btn btn-primary" disabled={busy || !Number.isInteger(count) || count < 1 || count > 500} onClick={() => void start()}>Start batch</button><button className="btn" disabled={busy || !Number.isInteger(count) || count < 1 || count > 500} onClick={() => void copyAgentPrompt()} title="No local model: your coding agent writes the exercises itself. Creates the batch and copies its task." data-testid="copy-agent-task"><i className="pi pi-copy" aria-hidden="true" /> Copy agent prompt</button>{category === "grammar" ? <button className="btn" disabled={busy} onClick={() => void calculateCourse()}>Calculate for lessons</button> : <button className="btn" disabled={busy} onClick={() => void calculateVocabulary()}>Calculate for words</button>}</div>
      {category === "grammar" && (thoughts.ready > 0 || thoughts.needSkills > 0) && <div className="actions" data-testid="thoughts-ready">
        {thoughts.needSkills > 0 && <><span className="small">{thoughts.needSkills} saved thought{thoughts.needSkills === 1 ? " needs" : "s need"} a grammar-skill check by your agent.</span><button className="btn" onClick={() => void navigator.clipboard?.writeText(THOUGHTS_AGENT_TASK).then(() => setNote("Task copied. Paste it to your coding agent."))}>Copy task for agent</button></>}
        {thoughts.ready > 0 && <><span className="small">{thoughts.ready} checked thought{thoughts.ready === 1 ? "" : "s"} ready to become practice patterns.</span><button className="btn" disabled={busy} onClick={() => void startThoughts()}>Create drafts from my thoughts</button></>}
      </div>}
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
      {course && <p className="small" role="status">Remaining lessons: {course.sessions} sessions across {course.lessons} lessons; estimated {course.deficit} exercises short, {course.recommended} drafts suggested with 20% review margin. Shared stock is allocated once; future repeats are not assumed. This is an estimate: recalculate after review and practice.</p>}
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
