import { useCallback, useEffect, useState } from "react";
import {
  ApiRequestError,
  createBatchApi,
  fetchBatch,
  fetchBatches,
  fetchCoverage,
  fetchRevisionContent,
  importReview,
  previewRelease,
  publishReleaseApi,
  type BatchItem,
  type BatchSummary,
  type Coverage,
  type ItemStatus,
  type TrialGate,
} from "../api";

const STATUS_LABEL: Record<ItemStatus, string> = {
  queued: "Waiting to be written",
  invalid: "Rejected by checks",
  generated: "Draft",
  ready_for_review: "Needs your review",
  approved: "Approved, not published",
  released: "Published",
  flagged: "Flagged",
  rejected: "Rejected by reviewer",
};
const ORDER: ItemStatus[] = ["queued", "ready_for_review", "approved", "released", "flagged", "rejected", "invalid", "generated"];
const FORMAT_LABEL: Record<string, string> = {
  choose_form: "Choose the form",
  choose_missing_fragment: "Choose the missing word",
  detect_error: "Find the mistake",
  guided_short_answer: "Finish the sentence",
  russian_to_english_short: "Say it in English",
  context_reading: "Reading",
};
const errText = (e: unknown): string => {
  if (!(e instanceof ApiRequestError)) return "Something went wrong.";
  const d = e.details as { problems?: Array<{ code: string; revisionId?: string; message: string }> } | null;
  return d?.problems && d.problems.length > 0 ? `${e.message} ${d.problems.slice(0, 5).map((p) => `${p.code}: ${p.message}`).join("; ")}` : e.message;
};
const short = (id: string | null) => (id ? id.slice(0, 8) : "—");

export function ContentStudio() {
  const [batches, setBatches] = useState<BatchSummary[] | null>(null);
  const [gate, setGate] = useState<TrialGate | null>(null);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [count, setCount] = useState(50);

  const load = useCallback(async () => {
    try {
      const [b, c] = await Promise.all([fetchBatches(), fetchCoverage()]);
      setBatches(b.batches);
      setGate(b.trialGate);
      setCoverage(c);
    } catch (e) {
      setError(errText(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const create = async (trial: boolean) => {
    setError(null);
    setNote(null);
    try {
      const r = await createBatchApi(trial ? { count: 24, mode: "balanced", trial: true } : { count, mode: "adaptive" });
      setNote(`Started: ${r.items} drafts in ${r.units} short tasks. Watch them in AI tasks.`);
      setOpenId(r.batchId);
      await load();
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <>
      <section className="card" aria-labelledby="cs-h">
        <h2 id="cs-h">Content Studio</h2>
        <p className="lede">New exercises are written as <strong>drafts</strong> by a small local model. A draft never reaches practice until a reviewer has read it and you have published it.</p>
        {error && <p className="notice notice-error" role="alert">{error}</p>}
        {note && <p className="notice notice-info" role="status">{note}</p>}
        {gate && (
          <div className={`notice ${gate.passed ? "notice-info" : "notice-warn"}`} data-testid="trial-gate">
            <strong>{gate.passed ? "Larger batches are open." : "Larger batches are closed."}</strong> {gate.reason}.
            <div className="small muted">Rule: a test batch of 24 drafts must be reviewed one by one and at least 18 approved ({gate.promptVersion}).</div>
          </div>
        )}
        <div className="actions">
          <button className="btn btn-primary" onClick={() => void create(true)} data-testid="create-trial">Start test batch (24 drafts)</button>
          <label className="inline">
            <span className="small">Batch size</span>
            <input type="number" min={1} max={500} value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="Batch size" />
          </label>
          <button className="btn" disabled={!gate?.passed} title={gate?.passed ? "" : "Review a test batch first"} onClick={() => void create(false)}>Start batch</button>
        </div>
      </section>

      <section className="card" aria-labelledby="bl-h">
        <h2 id="bl-h">Batches</h2>
        {batches === null ? (
          <p role="status">Loading…</p>
        ) : batches.length === 0 ? (
          <p className="muted">No batches yet. Start with the test batch.</p>
        ) : (
          <ul className="batch-list" data-testid="batches">
            {batches.map((b) => (
              <li key={b.id}>
                <button className={`batch-row${openId === b.id ? " batch-row-on" : ""}`} onClick={() => setOpenId(openId === b.id ? null : b.id)} aria-expanded={openId === b.id}>
                  <span><strong>{b.purpose === "trial" ? "Test batch" : "Batch"}</strong> <span className="muted small">#{short(b.id)} · {new Date(b.createdAt).toLocaleDateString()}</span></span>
                  <span className="chips">
                    {ORDER.filter((s) => b.counts[s] > 0).map((s) => (
                      <span key={s} className="chip">{b.counts[s]} {STATUS_LABEL[s].toLowerCase()}</span>
                    ))}
                  </span>
                </button>
                {openId === b.id && <BatchDetail id={b.id} onChanged={load} />}
              </li>
            ))}
          </ul>
        )}
      </section>

      {coverage && (
        <section className="card" aria-labelledby="cov-h">
          <h2 id="cov-h">Coverage</h2>
          <p>
            <strong>{coverage.totals.releasedExercises}</strong> published exercises. {coverage.totals.skillsWithDeficit} of {coverage.totals.skills} skills have fewer than {coverage.targetPerSkill} published.
          </p>
          <details>
            <summary>Skills with the biggest gaps</summary>
            <ul className="small">
              {[...coverage.skills].sort((a, b) => b.deficit - a.deficit || (a.skill < b.skill ? -1 : 1)).slice(0, 12).map((s) => (
                <li key={s.skill}><code>{s.skill}</code>: {s.released} published, {s.inReview} in review, {s.approvedUnreleased} approved</li>
              ))}
            </ul>
          </details>
        </section>
      )}
    </>
  );
}

function BatchDetail({ id, onChanged }: { id: string; onChanged: () => Promise<void> }) {
  const [data, setData] = useState<(BatchSummary & { items: BatchItem[] }) | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [manifest, setManifest] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [reviewer, setReviewer] = useState("human:me");
  const [preview, setPreview] = useState<{ hash: string; n: number } | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await fetchBatch(id));
    } catch (e) {
      setErr(errText(e));
    }
  }, [id]);
  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 4000);
    return () => clearInterval(t);
  }, [reload]);

  if (!data) return <p role="status" className="muted">Loading…</p>;
  const approved = data.items.filter((i) => i.status === "approved" && i.revisionId);
  const command = `npm run lab:export -- batch ${id}`;
  const task = `Review batch ${id} using ${command}. Read content/review-guidelines.md and judge EVERY item against the checklist. Return a content-review-v1 manifest (use reviewManifestTemplate from the export). Do not modify the database.`;

  const doImport = async () => {
    setErr(null);
    setMsg(null);
    try {
      const r = await importReview(id, JSON.parse(manifest));
      setMsg(`Recorded ${r.recorded} reviews: ${r.approved} approved, ${r.flagged} flagged, ${r.rejected} rejected.`);
      setManifest("");
      await reload();
      await onChanged();
    } catch (e) {
      setErr(e instanceof SyntaxError ? "That is not valid JSON." : errText(e));
    }
  };
  const doPreview = async () => {
    setErr(null);
    try {
      const p = await previewRelease([...picked]);
      setPreview({ hash: p.manifestHash, n: p.items.length });
    } catch (e) {
      setErr(errText(e));
    }
  };
  const doPublish = async () => {
    if (!preview) return;
    setErr(null);
    try {
      const r = await publishReleaseApi({ revisionIds: [...picked], reviewer, manifestHash: preview.hash });
      setMsg(`Published ${r.released} exercises. The rest of the batch was not published.`);
      setPicked(new Set());
      setPreview(null);
      await reload();
      await onChanged();
    } catch (e) {
      setErr(errText(e));
    }
  };

  return (
    <div className="batch-detail" data-testid="batch-detail">
      {err && <p className="notice notice-error" role="alert">{err}</p>}
      {msg && <p className="notice notice-info" role="status">{msg}</p>}
      <p className="small muted">Prompt {data.promptVersion}. {data.reviewedItems} of {data.requestedCount} reviewed. {data.generationDone ? "All drafts written." : "Still writing…"}</p>
      <div className="table-wrap">
        <table className="summary-table wide">
          <thead><tr><th /><th>#</th><th>Format</th><th>Skill</th><th>Status</th><th>Hints</th><th /></tr></thead>
          <tbody>
            {data.items.map((i) => (
              <ItemRow key={i.ordinal} item={i} picked={picked.has(i.revisionId ?? "")} canPick={i.status === "approved"} onPick={(on) => { const n = new Set(picked); if (on && i.revisionId) n.add(i.revisionId); else n.delete(i.revisionId ?? ""); setPicked(n); setPreview(null); }} />
            ))}
          </tbody>
        </table>
      </div>

      <h3>1. Have the drafts reviewed</h3>
      <p className="small">A strong agent (or you) must read every draft. Give it this task, then paste the manifest it returns. Hints from the small screening model are only advice.</p>
      <label className="small" htmlFor={`cmd-${id}`}>Task for the reviewing agent</label>
      <textarea id={`cmd-${id}`} readOnly rows={3} value={task} onFocus={(e) => e.currentTarget.select()} />
      <label className="small" htmlFor={`mf-${id}`}>Review manifest (JSON)</label>
      <textarea id={`mf-${id}`} rows={4} value={manifest} onChange={(e) => setManifest(e.target.value)} placeholder='{"schema_version":"content-review-v1", …}' />
      <div className="actions"><button className="btn" disabled={manifest.trim() === ""} onClick={() => void doImport()}>Import reviews</button></div>

      <h3>2. Publish approved drafts</h3>
      {approved.length === 0 ? (
        <p className="muted small">Nothing is approved yet. Only approved drafts can be published, and only the ones you tick.</p>
      ) : (
        <>
          <p className="small">{approved.length} approved, {picked.size} ticked.</p>
          <label className="small" htmlFor={`rv-${id}`}>Published by</label>
          <input id={`rv-${id}`} value={reviewer} onChange={(e) => setReviewer(e.target.value)} />
          <div className="actions">
            <button className="btn" disabled={picked.size === 0} onClick={() => void doPreview()}>Check the release</button>
            <button className="btn btn-primary" disabled={!preview} onClick={() => void doPublish()}>Publish {preview ? preview.n : ""} exercises</button>
          </div>
          {preview && <p className="small muted">Checked {preview.n} exercises (fingerprint {preview.hash.slice(0, 10)}). Publishing refuses if anything changed since.</p>}
        </>
      )}
    </div>
  );
}

function ItemRow({ item, picked, canPick, onPick }: { item: BatchItem; picked: boolean; canPick: boolean; onPick: (on: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<Record<string, unknown> | null>(null);
  const flags = item.advisory?.flags ?? [];
  const toggle = async () => {
    setOpen(!open);
    if (!open && item.revisionId && !content) setContent((await fetchRevisionContent(item.revisionId)).content);
  };
  return (
    <>
      <tr data-status={item.status}>
        <td>{canPick && <input type="checkbox" checked={picked} onChange={(e) => onPick(e.target.checked)} aria-label={`Publish draft ${item.ordinal + 1}`} />}</td>
        <td>{item.ordinal + 1}</td>
        <td>{FORMAT_LABEL[item.plan.type] ?? item.plan.type}</td>
        <td><code>{item.plan.target_skill}</code></td>
        <td><span className={`badge ${item.status === "released" || item.status === "approved" ? "badge-ok" : item.status === "invalid" || item.status === "rejected" || item.status === "flagged" ? "badge-warn" : "badge-info"}`}>{STATUS_LABEL[item.status]}</span></td>
        <td>{flags.length > 0 ? <span className="badge badge-warn" title={flags.map((f) => `${f.code}: ${f.text}`).join("\n")}>{flags.length} hint{flags.length > 1 ? "s" : ""}</span> : <span className="muted">—</span>}</td>
        <td>{(item.revisionId || item.error != null) && <button className="link" onClick={() => void toggle()} aria-expanded={open}>{open ? "Hide" : "View"}</button>}</td>
      </tr>
      {open && (
        <tr className="detail-row">
          <td colSpan={7}>
            {flags.length > 0 && (
              <ul className="small hints">
                {flags.map((f, k) => (
                  <li key={k}><strong>{f.code === "KEY_LOOKS_WRONG" ? "The right answer may read wrong:" : "A wrong option may read fine:"}</strong> “{f.text}” <span className="muted">(small-model advice, check yourself)</span></li>
                ))}
              </ul>
            )}
            {content ? <Preview c={content} /> : item.error != null ? <pre className="small">{JSON.stringify(item.error, null, 1).slice(0, 600)}</pre> : <p className="muted">Loading…</p>}
          </td>
        </tr>
      )}
    </>
  );
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
