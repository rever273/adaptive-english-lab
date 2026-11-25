import { useCallback, useEffect, useState } from "react";
import { NumberInput } from "../components/NumberInput";
import {
  ApiRequestError,
  cancelContextLoopAgentBatch,
  createContextLoopAgentBatch,
  editContextLoopSentence,
  fetchContextLoopSentences,
  fetchContextLoopStudio,
  generateContextLoop,
  setContextLoopSentenceStatus,
  type ContextLoopSentenceView,
  type ContextLoopStudioStatus,
} from "../api";

const errorText = (e: unknown) => (e instanceof ApiRequestError ? e.message : "Something went wrong.");
const REASON: Record<string, string> = {
  context_loop_empty: "no sentence passed the checks",
  transport_failed: "the model server did not answer",
  model_digest_mismatch: "the installed model differs from the pinned one",
  cancelled: "cancelled",
  no_sentences: "nothing was written",
};
const STATUS_LABEL: Record<ContextLoopSentenceView["status"], string> = { validated: "checked by the local AI", approved: "reviewed by an agent", flagged: "flagged", rejected: "hidden" };

/** the sentence with its target word marked */
function Marked({ s }: { s: ContextLoopSentenceView }) {
  return (
    <>
      {s.text.slice(0, s.targetStart)}
      <mark>{s.text.slice(s.targetStart, s.targetStart + s.targetLength)}</mark>
      {s.text.slice(s.targetStart + s.targetLength)}
    </>
  );
}

function SentenceRow({ s, onChanged }: { s: ContextLoopSentenceView; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(s.text);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      setEditing(false);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const off = s.status === "rejected" || s.status === "flagged";
  return (
    <li className={`cls-sentence cls-${s.status}${s.stale ? " cls-stale" : ""}`} data-testid="context-loop-sentence">
      {editing ? (
        <span className="field-add">
          <input value={text} onChange={(e) => setText(e.target.value)} aria-label="Sentence" maxLength={200} />
          <button className="btn btn-ok" onClick={() => void run(() => editContextLoopSentence(s.id, text))} disabled={!text.trim() || text.trim() === s.text}>Save</button>
          <button className="btn" onClick={() => { setEditing(false); setText(s.text); }}>Cancel</button>
        </span>
      ) : (
        <span><Marked s={s} /></span>
      )}{" "}
      <span className="muted small">
        · {s.contextLabel} · {STATUS_LABEL[s.status]}{s.stale ? " · written for an older translation" : ""}{s.reason && s.status !== "validated" && s.status !== "approved" ? ` — ${s.reason}` : ""}
      </span>{" "}
      {!editing && (
        <span className="icon-actions">
          {off ? (
            <button className="link small" onClick={() => void run(() => setContextLoopSentenceStatus(s.id, "validated"))}>{s.status === "flagged" ? "Use anyway" : "Restore"}</button>
          ) : (
            <button className="link small" onClick={() => void run(() => setContextLoopSentenceStatus(s.id, "rejected"))}>Hide</button>
          )}
          <button className="link small" onClick={() => setEditing(true)}>Edit</button>
        </span>
      )}
      {error && <span className="small notice notice-warn" role="alert">{error}</span>}
    </li>
  );
}

function Review() {
  const [list, setList] = useState<ContextLoopSentenceView[] | null>(null);
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const load = useCallback(async () => {
    try {
      setList((await fetchContextLoopSentences(flaggedOnly ? { status: "flagged" } : {})).sentences);
    } catch {
      setList([]);
    }
  }, [flaggedOnly]);
  useEffect(() => void load(), [load]);
  if (!list) return <p role="status" className="small muted">Loading…</p>;
  const byWord = new Map<string, ContextLoopSentenceView[]>();
  for (const s of list) (byWord.get(s.lemma) ?? byWord.set(s.lemma, []).get(s.lemma)!).push(s);
  return (
    <div>
      <label className="inline toggle small"><input type="checkbox" checked={flaggedOnly} onChange={(e) => setFlaggedOnly(e.target.checked)} /> Flagged only</label>
      {byWord.size === 0 && <p className="muted small">No sentences yet.</p>}
      {[...byWord.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([lemma, ss]) => (
        <details key={lemma}>
          <summary><strong>{lemma}</strong> <span className="muted small">{ss.filter((s) => (s.status === "validated" || s.status === "approved") && !s.stale).length} in practice · {ss.length} in all</span></summary>
          <ul className="cls-list">{ss.map((s) => <SentenceRow key={s.id} s={s} onChanged={() => void load()} />)}</ul>
        </details>
      ))}
    </div>
  );
}

/**
 * Content Studio → Vocabulary: sentences for Context Loop (TASK_037). Written ahead of time by the local AI or by a coding agent (Copy agent prompt);
 * looking at them is optional: hide, restore or edit a sentence here.
 */
export function ContextLoopStudio() {
  const [st, setSt] = useState<ContextLoopStudioStatus | null>(null);
  const [words, setWords] = useState(10);
  const [perWord, setPerWord] = useState(4);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<{ text: string; copied: boolean } | null>(null);
  const [review, setReview] = useState(false);

  const load = useCallback(async () => {
    try {
      setSt(await fetchContextLoopStudio());
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => void load(), [load]);
  const working = (st?.batches ?? []).some((b) => b.status === "generating");
  useEffect(() => {
    if (!working) return;
    const t = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(t);
  }, [working, load]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const generate = () =>
    act(async () => {
      const r = await generateContextLoop(words, perWord);
      setSt(r.status);
      setNote(`Started sentences for ${r.created} word${r.created === 1 ? "" : "s"}. Progress is shown in AI Tasks.`);
    });
  const agent = () =>
    act(async () => {
      const r = await createContextLoopAgentBatch(words, perWord);
      setSt(r.status);
      let copied = false;
      try {
        await navigator.clipboard.writeText(r.prompt);
        copied = true;
      } catch {
        /* shown below for manual copying */
      }
      setPrompt({ text: r.prompt, copied });
    });

  return (
    <section className="card" aria-labelledby="cls-h" data-testid="context-loop-studio">
      <h2 id="cls-h"><i className="pi pi-sync" aria-hidden="true" /> Context Loop sentences</h2>
      <p className="lede">Short sentences for Context Loop: each saved word in several different situations. They are written ahead of time, by the local AI or by your coding agent, and checked before they are used. Looking through them is optional.</p>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {note && <p className="notice notice-info" role="status">{note}</p>}
      {prompt && (
        <div className="notice notice-info" role="status">
          {prompt.copied ? "Prompt copied. Paste it into your coding agent's chat." : "Could not use the clipboard. Select and copy the text below."}
          <textarea readOnly value={prompt.text} rows={4} style={{ width: "100%" }} onFocus={(e) => e.currentTarget.select()} aria-label="Agent prompt" />
        </div>
      )}
      {st && (
        <>
          <p data-testid="context-loop-coverage">
            <strong>{st.coverage.playable} / {st.coverage.eligible}</strong> words ready to practise · {st.coverage.ready} with three or more sentences · {st.coverage.missing} need sentences
            {st.coverage.stale > 0 && ` · ${st.coverage.stale} with sentences for an older translation`}
            {st.flagged > 0 && ` · ${st.flagged} flagged`}
          </p>
          <div className="actions">
            <label className="inline"><span>Words</span><NumberInput min={st.limits.words.min} max={st.limits.words.max} value={words} aria-label="Words to prepare" onChange={setWords} /></label>
            <label className="inline"><span>Sentences per word</span><NumberInput min={st.limits.perWord.min} max={st.limits.perWord.max} value={perWord} aria-label="Sentences per word" onChange={setPerWord} /></label>
            <button className="btn btn-primary" disabled={busy || st.candidates === 0} onClick={() => void generate()} data-testid="context-loop-generate">Generate with local AI</button>
            <button className="btn" disabled={busy || st.candidates === 0} onClick={() => void agent()} data-testid="context-loop-agent">Copy agent prompt</button>
          </div>
          {st.candidates === 0 && st.coverage.eligible > 0 && <p className="muted small">Every word you have not marked learned already has sentences or is being prepared.</p>}
          {st.batches.length > 0 && (
            <ul className="small">
              {st.batches.map((b) => (
                <li key={b.id}>
                  {new Date(b.createdAt).toLocaleString("en-AU")} · {b.author === "agent" ? "agent" : "local AI"} · {b.words} words × {b.perWord} ·{" "}
                  {b.status === "generating" ? "being written" : b.status === "awaiting_agent" ? "waiting for the agent" : b.status === "failed" ? `failed (${REASON[b.errorCode ?? ""] ?? b.errorCode ?? "unknown"})` : b.receipt ? `${b.receipt.accepted} accepted, ${b.receipt.flagged} flagged, ${b.receipt.rejected} rejected` : `${b.sentences} sentences`}
                  {b.status === "awaiting_agent" && <> <button className="link small" disabled={busy} onClick={() => void act(async () => setSt(await cancelContextLoopAgentBatch(b.id)))}>Cancel</button></>}
                </li>
              ))}
            </ul>
          )}
          <button className="link" onClick={() => setReview(!review)} aria-expanded={review}>{review ? "Hide sentences" : "Review sentences"}</button>
          {review && <Review />}
        </>
      )}
    </section>
  );
}
