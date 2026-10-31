import { useCallback, useEffect, useRef, useState } from "react";
import type { FeedbackResponse } from "@english-lab/contracts";
import { ApiRequestError, askTutor, fetchAgentTask, fetchFeedback, fetchTutorSlots, fetchTutorThread, type TutorSlot, type TutorThread } from "../api";
import { FORMAT_LOOK } from "../components/PromptView";

const OUTCOME: Record<string, { icon: string; cls: string; label: string }> = {
  correct: { icon: "pi-check-circle", cls: "ok", label: "Correct" },
  incorrect: { icon: "pi-times-circle", cls: "bad", label: "Not this time" },
  idk: { icon: "pi-question-circle", cls: "idk", label: "I don't know" },
  pending: { icon: "pi-hourglass", cls: "wait", label: "Waiting for a check" },
  skipped: { icon: "pi-forward", cls: "skip", label: "Skipped" },
};

type Kind = "why" | "explain_ru" | "more_examples" | "question";

/** "verb_patterns.think_of_doing" -> { topic: "verb patterns", name: "think of doing" } */
export function skillName(id: string): { topic: string; name: string } {
  const [topic = "", ...rest] = id.split(".");
  const tidy = (s: string) => s.replace(/_/g, " ");
  return rest.length ? { topic: tidy(topic), name: tidy(rest.join(" · ")) } : { topic: "", name: tidy(topic) };
}

/** the part of a task worth reading first; a "Начни: …" start is shown separately and smaller */
function keyPart(prompt: string): { main: string; start: string | null } {
  const m = prompt.split(/\s*Начни:\s*/);
  return m.length > 1 ? { main: m[0]!.trim(), start: m.slice(1).join(" ").trim() } : { main: prompt, start: null };
}

function Message({ m }: { m: TutorThread["messages"][number] }) {
  if (m.role === "user") return <p className="tutor-ask small" data-testid="tutor-user"><i className="pi pi-user" aria-hidden="true" /> {m.text}</p>;
  return (
    <div className={`tutor-reply ${m.source === "approved_exercise" ? "tutor-reply-rule" : "tutor-reply-ai"}`} data-testid="tutor-reply" data-source={m.source}>
      <p className="small tutor-reply-head">
        {m.source === "approved_exercise" ? <><i className="pi pi-verified" aria-hidden="true" /> Approved rule</> : <><i className="pi pi-sparkles" aria-hidden="true" /> Local AI — a draft, not checked</>}
      </p>
      <p lang="ru" className="ru">{m.text}</p>
      {m.examples.length > 0 && <ul className="small">{m.examples.map((e, i) => <li key={i}>{e}</li>)}</ul>}
      {m.uncertaintyNoteRu && <p lang="ru" className="ru small muted">{m.uncertaintyNoteRu}</p>}
    </div>
  );
}

function SlotItem({ s, on, onPick }: { s: TutorSlot; on: boolean; onPick: () => void }) {
  const f = FORMAT_LOOK[s.type];
  const o = OUTCOME[s.outcome] ?? OUTCOME.skipped!;
  const k = keyPart(s.prompt);
  const sk = skillName(s.skill);
  return (
    <li>
      <button type="button" className={`slot-item fmt-${s.type}${on ? " slot-item-on" : ""}`} onClick={onPick} aria-pressed={on} data-slot-id={s.slotId}>
        <span className="slot-fmt" title={f?.label ?? s.type}><i className={`pi ${f?.icon ?? "pi-circle"}`} aria-hidden="true" /><span className="slot-fmt-label">{f?.label ?? s.type}</span></span>
        <span className="slot-body">
          <span className="slot-main">{k.main}</span>
          {k.start && <span className="slot-start">Start: {k.start}</span>}
        </span>
        <span className="slot-meta">
          <span className="chip" title={s.skill}>{sk.name}</span>
          <span className={`slot-outcome review-${o.cls}`} title={o.label}><i className={`pi ${o.icon}`} aria-hidden="true" /><span className="visually-hidden">{o.label}</span></span>
        </span>
      </button>
    </li>
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
  const [filter, setFilter] = useState<"mistakes" | "all">("mistakes");
  const [key, setKey] = useState<FeedbackResponse | null>(null);
  const [sending, setSending] = useState<Kind | null>(null);

  useEffect(() => {
    setSlots(null);
    setChosen(null);
    fetchTutorSlots(filter).then((r) => setSlots(r.slots)).catch((e) => setError(e instanceof ApiRequestError ? e.message : "Cannot load your tasks."));
  }, [filter]);

  // the answer key and the learner's own first answer for the chosen task (same gate as the practice feedback)
  useEffect(() => {
    setKey(null);
    if (!chosen) return;
    let off = false;
    fetchFeedback(chosen.sessionId, chosen.slotId).then((f) => !off && setKey(f)).catch(() => undefined);
    return () => {
      off = true;
    };
  }, [chosen]);

  const load = useCallback(async (slot: TutorSlot) => setThread(await fetchTutorThread(slot.slotId)), []);
  useEffect(() => {
    if (!chosen) return;
    void load(chosen);
    const t = setInterval(() => void load(chosen), 4000); // a queued AI answer appears when it arrives
    return () => clearInterval(t);
  }, [chosen, load]);

  const ask = async (kind: Kind) => {
    if (!chosen || sending) return;
    setError(null);
    setSending(kind);
    try {
      const r = await askTutor({ sessionId: chosen.sessionId, slotId: chosen.slotId, kind, ...(kind === "question" ? { question } : {}) });
      setThread((t) => ({ slotId: chosen.slotId, messages: r.messages, pendingJobs: (t?.pendingJobs ?? 0) + (r.jobId ? 1 : 0), pendingKinds: r.jobId ? [...new Set([...(t?.pendingKinds ?? []), kind])] : t?.pendingKinds ?? [] }));
      if (kind === "question") setQuestion("");
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not ask the tutor.");
    } finally {
      setSending(null);
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

  const waiting = (k: Kind) => sending === k || (thread?.pendingKinds ?? []).includes(k);
  const askButton = (kind: Kind, icon: string, label: string, testId?: string) => (
    <button className="btn" disabled={waiting(kind) || (sending !== null && sending !== kind)} onClick={() => void ask(kind)} data-testid={testId} aria-busy={waiting(kind)}>
      <i className={`pi ${waiting(kind) ? "pi-spin pi-spinner" : icon}`} aria-hidden="true" /> {label}
      {waiting(kind) && kind !== "why" && <span className="small muted"> · writing…</span>}
    </button>
  );

  const pick = (s: TutorSlot) => {
    setThread(null);
    setTask(null);
    setChosen(s);
  };
  const k = chosen ? keyPart(chosen.prompt) : null;
  return (
    <section className="card" aria-labelledby="tu-h">
      <h2 id="tu-h"><i className="pi pi-comments" aria-hidden="true" /> Tutor</h2>
      <p className="lede">Ask about a task you have already answered. Unconfirmed AI assessments and explanations can be wrong. <strong>Why?</strong> shows the approved rule at once. <strong>Explain in Russian</strong>, <strong>More examples</strong> and your own questions are written by the local AI when the computer is free. Nothing here changes your score.</p>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      <div className="segmented" role="radiogroup" aria-label="Which tasks">
        <label className={filter === "mistakes" ? "on" : ""}><input type="radio" name="tutor-filter" checked={filter === "mistakes"} onChange={() => setFilter("mistakes")} /> <i className="pi pi-times-circle" aria-hidden="true" /> Mistakes and answers to check</label>
        <label className={filter === "all" ? "on" : ""}><input type="radio" name="tutor-filter" checked={filter === "all"} onChange={() => setFilter("all")} data-testid="tutor-filter-all" /> <i className="pi pi-list" aria-hidden="true" /> All recent tasks</label>
      </div>
      {slots === null ? (
        <p role="status">Loading…</p>
      ) : slots.length === 0 ? (
        <p className="muted">{filter === "mistakes" ? "No mistakes to look at. Nicely done — or switch to all recent tasks." : "Nothing to ask about yet. Answer a task in Practice first; diagnostic tasks open after their block is finished."}</p>
      ) : (
        <ul className="slot-list" data-testid="tutor-slot" aria-label="Tasks">
          {slots.map((s) => <SlotItem key={s.slotId} s={s} on={chosen?.slotId === s.slotId} onPick={() => pick(s)} />)}
        </ul>
      )}
      {chosen && k && (
        <div className={`card inset task fmt-${chosen.type}`}>
          <p className="format-tag"><i className={`pi ${FORMAT_LOOK[chosen.type]?.icon ?? "pi-circle"}`} aria-hidden="true" /> {FORMAT_LOOK[chosen.type]?.label ?? chosen.type} · {skillName(chosen.skill).topic} · {skillName(chosen.skill).name}</p>
          <p className="prompt">{k.main}</p>
          {k.start && <p className="muted small">Start: {k.start}</p>}
          {key && key.state !== "closed" && (
            <div className="small key-block" data-testid="tutor-key">
              {key.yourAnswer && <p className={key.verdict === "incorrect" || key.verdict === "idk" ? "answer-yours-bad" : ""}>Your answer: <strong>{key.yourAnswer}</strong></p>}
              {key.correct?.options && <p className="answer-key"><i className="pi pi-check" aria-hidden="true" /> Right answer: <strong>{key.correct.options.join(" / ")}</strong></p>}
              {key.correct?.noMistake && <p className="answer-key"><i className="pi pi-check" aria-hidden="true" /> Right answer: <strong>No mistake</strong></p>}
              {key.correct?.segments && <p className="answer-key"><i className="pi pi-check" aria-hidden="true" /> The mistake: <strong>{key.correct.segments.join(" / ")}</strong>{key.correct.corrections?.length ? <> → <strong>{key.correct.corrections.join(" / ")}</strong></> : null}</p>}
              {key.correct?.answers && <p className="answer-key"><i className="pi pi-check" aria-hidden="true" /> Approved sentences: <strong>{key.correct.answers.join(" · ")}</strong></p>}
            </div>
          )}
          <div className="actions">
            {askButton("why", "pi-verified", "Why?", "tutor-why")}
            {askButton("explain_ru", "pi-language", "Explain in Russian", "tutor-explain")}
            {askButton("more_examples", "pi-list", "More examples", "tutor-more")}
          </div>
          <div className="field-add">
            <input value={question} maxLength={2000} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => e.key === "Enter" && question.trim() && void ask("question")} placeholder="Your own question about this rule" aria-label="Your question" data-testid="tutor-question" />
            <button className="btn" disabled={!question.trim() || waiting("question")} onClick={() => void ask("question")}>
              <i className={`pi ${waiting("question") ? "pi-spin pi-spinner" : "pi-send"}`} aria-hidden="true" /> Ask
            </button>
          </div>
          {thread && thread.pendingJobs > 0 && (
            <p className="small muted" role="status" data-testid="tutor-pending"><i className="pi pi-spin pi-spinner" aria-hidden="true" /> The local AI is writing an answer. It starts when the computer is free (never during Practice).</p>
          )}
          <div className="tutor-thread">{thread?.messages.map((m) => <Message key={m.id} m={m} />)}</div>
          <details className="small">
            <summary>For an outside reviewer</summary>
            <p className="muted">Copies a short text with IDs only. Your VS Code agent reads the details with a read-only command; it never receives your whole history.</p>
            <div className="actions">
              <button className="btn btn-small" onClick={() => void copy("session", chosen.sessionId)} data-testid="copy-session">Copy Agent Task: this session</button>
              <button className="btn btn-small" onClick={() => void copy("exercise", chosen.revisionId)} data-testid="copy-exercise">Copy Agent Task: this exercise</button>
            </div>
            {task && (
              <div data-testid="agent-task">
                <p role="status">{task.copied ? "Copied to the clipboard." : "Could not use the clipboard. Select and copy the text below."}</p>
                <textarea ref={taskBox} readOnly rows={4} value={task.text} aria-label="Agent task text" style={{ width: "100%" }} />
              </div>
            )}
          </details>
        </div>
      )}
      <p className="muted small">Tutor examples are drafts, not exercises, and are not counted as practice.</p>
    </section>
  );
}
