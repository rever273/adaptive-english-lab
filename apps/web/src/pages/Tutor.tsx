import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, askTutor, fetchAgentTask, fetchTutorSlots, fetchTutorThread, type TutorSlot, type TutorThread } from "../api";

type Kind = "why" | "explain_ru" | "more_examples" | "question";

function Message({ m }: { m: TutorThread["messages"][number] }) {
  if (m.role === "user") return <p className="small" data-testid="tutor-user"><strong>You:</strong> {m.text}</p>;
  return (
    <div className="card inset" data-testid="tutor-reply" data-source={m.source}>
      <p className="small">
        {m.source === "approved_exercise" ? <span className="badge badge-ok">Approved rule</span> : <span className="badge badge-info" title="Written by the local AI. It is not checked by a person.">AI draft</span>}
      </p>
      <p lang="ru" className="ru">{m.text}</p>
      {m.examples.length > 0 && (
        <ul className="small">{m.examples.map((e, i) => <li key={i}>{e}</li>)}</ul>
      )}
      {m.uncertaintyNoteRu && <p lang="ru" className="ru small muted">{m.uncertaintyNoteRu}</p>}
    </div>
  );
}

export function Tutor() {
  const [slots, setSlots] = useState<TutorSlot[] | null>(null);
  const [chosen, setChosen] = useState<TutorSlot | null>(null);
  const [thread, setThread] = useState<TutorThread | null>(null);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [task, setTask] = useState<{ text: string; copied: boolean } | null>(null);
  const taskBox = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetchTutorSlots().then((r) => setSlots(r.slots)).catch((e) => setError(e instanceof ApiRequestError ? e.message : "Cannot load your tasks."));
  }, []);

  const load = useCallback(async (slot: TutorSlot) => setThread(await fetchTutorThread(slot.slotId)), []);
  useEffect(() => {
    if (!chosen) return;
    void load(chosen);
    const t = setInterval(() => void load(chosen), 5000); // a queued AI answer appears when it arrives
    return () => clearInterval(t);
  }, [chosen, load]);

  const ask = async (kind: Kind) => {
    if (!chosen) return;
    setError(null);
    try {
      const r = await askTutor({ sessionId: chosen.sessionId, slotId: chosen.slotId, kind, ...(kind === "question" ? { question } : {}) });
      setThread((t) => ({ slotId: chosen.slotId, messages: r.messages, pendingJobs: (t?.pendingJobs ?? 0) + (r.jobId ? 1 : 0) }));
      if (kind === "question") setQuestion("");
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not ask the tutor.");
    }
  };

  const copy = async (kind: "session" | "exercise", id: string) => {
    setError(null);
    try {
      const { text } = await fetchAgentTask(kind, id);
      try {
        await navigator.clipboard.writeText(text);
        setTask({ text, copied: true });
      } catch {
        setTask({ text, copied: false }); // clipboard refused: show selectable text instead of claiming success
        setTimeout(() => taskBox.current?.select(), 0);
      }
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not build the task text.");
    }
  };

  return (
    <section className="card" aria-labelledby="tu-h">
      <h2 id="tu-h">Tutor</h2>
      <p className="lede">Ask about a task you have already answered. The approved rule appears at once; extra examples and free questions are written by the local AI when the computer is free, and are labelled as drafts. Nothing here changes your score.</p>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {slots === null ? (
        <p role="status">Loading…</p>
      ) : slots.length === 0 ? (
        <p className="muted">Nothing to ask about yet. Answer a task in Practice first; diagnostic tasks open after their block is finished.</p>
      ) : (
        <div className="form-grid">
          <label>Task
            <select value={chosen?.slotId ?? ""} onChange={(e) => { setThread(null); setTask(null); setChosen(slots.find((s) => s.slotId === e.target.value) ?? null); }} data-testid="tutor-slot">
              <option value="">(choose a task)</option>
              {slots.map((s) => <option key={s.slotId} value={s.slotId}>{`${s.purpose} · #${s.ordinal + 1} · ${s.skill} · ${s.prompt.slice(0, 60)}`}</option>)}
            </select>
          </label>
        </div>
      )}
      {chosen && (
        <>
          <p className="small"><strong>{chosen.prompt}</strong> <span className="muted">({chosen.skill})</span></p>
          <div className="actions">
            <button className="btn" onClick={() => void ask("why")} data-testid="tutor-why">Why?</button>
            <button className="btn" onClick={() => void ask("explain_ru")}>Explain in Russian</button>
            <button className="btn" onClick={() => void ask("more_examples")} data-testid="tutor-more">More examples</button>
          </div>
          <div className="actions">
            <label className="inline"><span className="small">Your question</span><input value={question} maxLength={2000} onChange={(e) => setQuestion(e.target.value)} aria-label="Your question" data-testid="tutor-question" /></label>
            <button className="btn" disabled={!question.trim()} onClick={() => void ask("question")}>Ask</button>
          </div>
          {thread && thread.pendingJobs > 0 && <p className="small muted" role="status" data-testid="tutor-pending">The AI answer is queued. It starts when the computer is free (never during Practice).</p>}
          {thread?.messages.map((m) => <Message key={m.id} m={m} />)}
          <h3>For an outside reviewer</h3>
          <p className="small muted">Copies a short text with IDs only. Your VS Code agent reads the details with a read-only command; it never receives your whole history.</p>
          <div className="actions">
            <button className="btn" onClick={() => void copy("session", chosen.sessionId)} data-testid="copy-session">Copy Agent Task: this session</button>
            <button className="btn" onClick={() => void copy("exercise", chosen.revisionId)} data-testid="copy-exercise">Copy Agent Task: this exercise</button>
          </div>
          {task && (
            <div data-testid="agent-task">
              <p className="small" role="status">{task.copied ? "Copied to the clipboard." : "Could not use the clipboard. Select and copy the text below."}</p>
              <textarea ref={taskBox} readOnly rows={4} value={task.text} aria-label="Agent task text" style={{ width: "100%" }} />
            </div>
          )}
        </>
      )}
      <p className="muted small">Tutor examples are drafts, not exercises, and are not counted as practice.</p>
    </section>
  );
}
