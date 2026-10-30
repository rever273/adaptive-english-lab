import type { Dashboard, FeedbackResponse, RevealResponse, SessionSnapshot, SessionSummary } from "@english-lab/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import { ApiRequestError } from "../api";
import { PromptView } from "../components/PromptView";
import { useVoice } from "../voice";
import { WordPopup } from "../components/WordPopup";
import { AgentTasks } from "../components/AgentTasks";

/** One tab id per browser tab, kept across reloads, so a reload resumes the same practice lease instead of waiting 90 s. */
function tabId(): string {
  try {
    const existing = sessionStorage.getItem("el_tab");
    if (existing) return existing;
    const id = crypto.randomUUID();
    sessionStorage.setItem("el_tab", id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

type View =
  | { kind: "loading" }
  | { kind: "dashboard"; dashboard: Dashboard; message: string | null }
  | { kind: "session"; session: SessionSnapshot }
  | { kind: "summary"; summary: SessionSummary };

type SlotUi = {
  reveal: RevealResponse | null;
  feedback: FeedbackResponse | null;
  hint: string | null;
  /** the attempt id of a submission that has not been confirmed yet; reused on retry so it never double-counts */
  pendingSubmission: { id: string; answer?: string | string[]; idk?: boolean; transcriptId?: string } | null;
  busy: boolean;
  error: string | null;
};
const emptySlot: SlotUi = { reveal: null, feedback: null, hint: null, pendingSubmission: null, busy: false, error: null };

export function Practice() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [slotUi, setSlotUi] = useState<SlotUi>(emptySlot);
  const [readOnly, setReadOnly] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [stt, setStt] = useState<{ ready: boolean }>({ ready: false });
  const [recent, setRecent] = useState<SessionSummary | null>(null);
  useEffect(() => {
    void api.fetchCapabilities().then((c) => setStt({ ready: c.stt.status === "ready" })).catch(() => undefined);
  }, []);
  const tab = useRef(tabId());

  const loadDashboard = useCallback(async (message: string | null = null) => {
    try {
      const current = await api.fetchCurrentSession();
      if (current.session) {
        setView({ kind: "session", session: current.session });
        return;
      }
      const [dashboard, last] = await Promise.all([api.fetchDashboard(), api.fetchRecentSession()]);
      setRecent(last);
      setView({ kind: "dashboard", dashboard, message });
    } catch (e) {
      setView({ kind: "dashboard", dashboard: { activeSessionId: null, taskCount: 0, blueprints: [], banner: null, diagnostic: { protocol: "diagnostic-v1", blocksTotal: 3, blocksUsed: 0, nextBlock: null, ready: false, shortage: null }, heldout: { protocol: "heldout-v1", availableTasks: 0, eligibleSkills: 0, minDelayDays: 7, ready: false, reason: null } }, message: errorText(e) });
    }
  }, []);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  // keep the practice lease alive while a session is open (heartbeat 15 s, D09)
  const sessionId = view.kind === "session" ? view.session.sessionId : null;
  const voice = useVoice(sessionId, tabId(), stt.ready);
  useEffect(() => {
    if (!sessionId) return;
    let stopped = false;
    const beat = async () => {
      try {
        await api.takeLease(sessionId, tab.current);
        if (!stopped) setReadOnly(null);
      } catch (e) {
        if (!stopped && e instanceof ApiRequestError && e.code === "LEASE_HELD") setReadOnly("This session is open in another tab, or a closed tab still holds it for up to 90 seconds. This tab continues by itself as soon as the session is free.");
      }
    };
    void beat();
    const timer = window.setInterval(() => void beat(), 15_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [sessionId]);

  const openSlot = view.kind === "session" ? view.session.slots.find((s) => s.state !== "skipped" && s.state !== "continued") : undefined;
  const openSlotId = openSlot?.slotId ?? null;

  // reveal the current slot (idempotent: a reload shows the same prompt and exposes nothing new)
  useEffect(() => {
    if (!sessionId || !openSlotId || readOnly) return;
    let cancelled = false;
    setSlotUi(emptySlot);
    (async () => {
      try {
        const reveal = await api.revealSlot(sessionId, openSlotId, tab.current);
        if (cancelled) return;
        let feedback: FeedbackResponse | null = null;
        if (reveal.state === "answered") feedback = await api.fetchFeedback(sessionId, openSlotId).catch(() => null);
        if (!cancelled) setSlotUi({ ...emptySlot, reveal, feedback });
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiRequestError && (e.code === "LEASE_REQUIRED" || e.code === "LEASE_HELD")) setReadOnly("This session is open in another tab, or a closed tab still holds it for up to 90 seconds. This tab continues by itself as soon as the session is free.");
        else if (e instanceof ApiRequestError && e.code === "CONTENT_SHORTAGE") setSlotUi({ ...emptySlot, error: "This exercise is no longer available and no replacement was found. You can skip it or finish the session." });
        else setSlotUi({ ...emptySlot, error: errorText(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, openSlotId, readOnly]);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    setView({ kind: "session", session: await api.fetchSession(sessionId) });
  }, [sessionId]);

  async function start(blueprintRevisionId: string) {
    try {
      const { snapshot } = await api.createSession(blueprintRevisionId);
      setView({ kind: "session", session: snapshot });
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === "SESSION_ACTIVE") return loadDashboard();
      await loadDashboard(e instanceof ApiRequestError && e.code === "CONTENT_SHORTAGE" ? null : errorText(e));
    }
  }

  async function startCheck(purpose: "diagnostic" | "heldout") {
    try {
      const { snapshot } = await api.createCheckSession(purpose);
      setView({ kind: "session", session: snapshot });
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === "SESSION_ACTIVE") return loadDashboard();
      await loadDashboard(errorText(e));
    }
  }

  async function submit(answer: string | string[] | undefined, idk: boolean, voiceDraftId?: string) {
    if (!sessionId || !slotUi.reveal) return;
    let submission = slotUi.pendingSubmission ?? { id: crypto.randomUUID(), answer, idk: idk || undefined, transcriptId: undefined as string | undefined };
    if (voiceDraftId && !submission.transcriptId && typeof answer === "string" && voice.streamId) {
      // the learner confirmed the (possibly edited) text: only now does it become a transcript, text only
      try {
        submission = { ...submission, transcriptId: (await api.sttConfirm(voice.streamId, voiceDraftId, slotUi.reveal.slotId, answer)).transcriptId };
      } catch (e) {
        setSlotUi((u) => ({ ...u, error: `Unsaved: ${errorText(e)} Your text is kept here; press the button again to retry.` }));
        return;
      }
    }
    setSlotUi((u) => ({ ...u, busy: true, error: null, pendingSubmission: submission }));
    try {
      await api.submitAttempt({ slotId: slotUi.reveal.slotId, submissionId: submission.id, ...(submission.idk ? { idk: true } : { answer: submission.answer, transcriptId: submission.transcriptId }) });
      const feedback = await api.fetchFeedback(sessionId, slotUi.reveal.slotId);
      await refresh();
      setSlotUi((u) => ({ ...u, busy: false, pendingSubmission: null, feedback }));
    } catch (e) {
      // not saved (yet): the same submissionId is retried, so a flaky connection can never double-count an answer
      setSlotUi((u) => ({ ...u, busy: false, error: `Unsaved: ${errorText(e)} Your answer is kept here; press the button again to retry.` }));
    }
  }

  async function act(type: "hint" | "reveal_answer" | "skip" | "continue") {
    if (!sessionId || !slotUi.reveal) return;
    setSlotUi((u) => ({ ...u, busy: true, error: null }));
    try {
      const ev = await api.sendEvent(sessionId, slotUi.reveal.slotId, type);
      if (type === "hint") setSlotUi((u) => ({ ...u, busy: false, hint: ev.hint ?? "No more hints for this exercise." }));
      else if (type === "reveal_answer") {
        const feedback = await api.fetchFeedback(sessionId, slotUi.reveal.slotId);
        setSlotUi((u) => ({ ...u, busy: false, feedback }));
      } else {
        await refresh();
      }
    } catch (e) {
      setSlotUi((u) => ({ ...u, busy: false, error: errorText(e) }));
    }
  }

  async function showAnswerAndContinue() {
    if (!sessionId || !slotUi.reveal) return;
    setSlotUi((u) => ({ ...u, busy: true, error: null }));
    try {
      await api.sendEvent(sessionId, slotUi.reveal.slotId, "reveal_answer");
      const feedback = await api.fetchFeedback(sessionId, slotUi.reveal.slotId);
      setSlotUi((u) => ({ ...u, busy: false, feedback }));
    } catch (e) {
      setSlotUi((u) => ({ ...u, busy: false, error: errorText(e) }));
    }
  }

  async function finish(mode: "completed" | "ended_early") {
    if (!sessionId) return;
    try {
      setView({ kind: "summary", summary: await api.finishSession(sessionId, mode) });
    } catch (e) {
      setSlotUi((u) => ({ ...u, error: errorText(e) }));
    }
  }

  if (view.kind === "loading") return <p role="status">Loading…</p>;

  if (view.kind === "summary") {
    return <SummaryScreen summary={view.summary} onDone={() => void loadDashboard()} />;
  }

  if (view.kind === "dashboard") {
    return <><DashboardScreen dashboard={view.dashboard} message={view.message} onStart={(id) => void start(id)} onStartCheck={(p) => void startCheck(p)} />{recent && <button className="btn" data-testid="review-recent" onClick={() => setView({ kind: "summary", summary: recent })}>Review last session</button>}</>;
  }

  const session = view.session;
  const allClosed = session.progress.closed === session.progress.total;
  const answered = slotUi.feedback !== null;

  return (
    <section aria-labelledby="practice-h">
      <header className="session-header">
        <h2 id="practice-h">{session.purpose === "diagnostic" ? "Starting diagnostic" : session.purpose === "heldout" ? "Delayed check" : "Practice"}</h2>
        <p className="progress" data-testid="progress" aria-live="polite">
          {Math.min(session.progress.closed + 1, session.progress.total)} / {session.progress.total}
        </p>
      </header>
      {session.purpose !== "practice" && (
        <p className="notice notice-info small" data-testid="check-note">
          No hints in this one, so the result is honest. Answer, or say “I don’t know”. The correct answers appear when the block is finished.
        </p>
      )}
      <div className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={session.progress.total} aria-valuenow={session.progress.closed} aria-label="Session progress">
        <div style={{ width: `${(session.progress.closed / session.progress.total) * 100}%` }} />
      </div>

      {readOnly && (
        <div className="notice notice-warn" role="status">
          {readOnly}
        </div>
      )}

      {allClosed ? (
        <div className="card" data-testid="all-closed">
          <h3>All exercises are done</h3>
          <p>You can finish now to see your summary.</p>
          <button className="btn btn-primary" onClick={() => void finish("completed")}>
            Finish and see summary
          </button>
        </div>
      ) : slotUi.reveal ? (
        <div className="card" data-testid="slot" data-format={slotUi.reveal.format}>
          <WordPopup>
          {slotUi.reveal.inputPreference === "voice" && isShort(slotUi.reveal.format) && (
            <p className="badge badge-info" data-testid="voice-note">
              {stt.ready ? "You can speak this one: press “Speak instead”." : "Voice is not available on this computer right now. Please type your answer."}
            </p>
          )}
          <PromptView
            checkMode={session.purpose !== "practice"}
            key={`${slotUi.reveal.slotId}-${retry}`}
            reveal={slotUi.reveal}
            busy={slotUi.busy || readOnly !== null}
            locked={answered && !slotUi.pendingSubmission}
            hint={slotUi.hint}
            voice={isShort(slotUi.reveal.format) && stt.ready ? voice : undefined}
            onSubmit={(a, d) => void submit(a, false, d)}
            onIdk={() => void submit(undefined, true)}
            onSkip={() => void act("skip")}
            onHint={() => void act("hint")}
            onShowAnswer={() => void showAnswerAndContinue()}
          />
          {slotUi.feedback && <FeedbackPanel feedback={slotUi.feedback} busy={slotUi.busy} onTryAgain={() => {
                setRetry((r) => r + 1);
                setSlotUi((u) => ({ ...u, feedback: null }));
              }} onContinue={() => void act(slotUi.feedback?.verdict != null || slotUi.feedback?.state === "closed" ? "continue" : "skip")} />}
          {slotUi.error && (
            <div className="notice notice-error" role="alert" data-testid="error">
              {slotUi.error}
            </div>
          )}
          </WordPopup>
        </div>
      ) : slotUi.error ? (
        <div className="notice notice-error" role="alert">
          {slotUi.error}
          <div className="actions">
            <button className="btn" onClick={() => openSlot && void api.sendEvent(session.sessionId, openSlot.slotId, "skip").then(refresh)}>Skip it</button>
          </div>
        </div>
      ) : (
        <p role="status">Loading the exercise…</p>
      )}

      <p className="muted small">
        <button className="link" onClick={() => void finish("ended_early")}>
          End this session early
        </button>{" "}
        · Progress is saved on this computer after every answer.
      </p>
    </section>
  );
}

function FeedbackPanel({ feedback, busy, onTryAgain, onContinue }: { feedback: FeedbackResponse; busy: boolean; onTryAgain: () => void; onContinue: () => void }) {
  const incorrect = feedback.verdict === "incorrect" || feedback.verdict === "idk";
  const kind = feedback.state === "pending" ? "pending" : feedback.verdict === "correct" ? "ok" : incorrect ? "again" : "info";
  return (
    <div className={`feedback feedback-${kind}`} data-testid="feedback" data-state={feedback.state} data-verdict={feedback.verdict ?? ""} aria-live="polite">
      <p className="feedback-title">
        {feedback.state === "closed" ? "Saved" : feedback.state === "pending" ? "Saved — AI review later" : feedback.verdict === "correct" ? "Correct" : feedback.verdict === "idk" ? "No problem" : feedback.verdict === "incorrect" ? "Not this time" : feedback.state === "skipped" ? "Skipped" : "Answer"}
      </p>
      <p>{feedback.message}</p>
      {feedback.correct && (
        <div data-testid="correct-answer">
          {feedback.correct.noMistake && <p>This sentence is correct: <strong>No mistake</strong>.</p>}
          {feedback.correct.options && <p>Correct: <strong>{feedback.correct.options.join(" / ")}</strong></p>}
          {feedback.correct.segments && <p>The mistake: <strong>{feedback.correct.segments.join(" / ")}</strong></p>}
          {feedback.correct.corrections && feedback.correct.corrections.length > 0 && <p>Corrected: <strong>{feedback.correct.corrections.join(" / ")}</strong></p>}
          {feedback.correct.answers && (
            <p>
              Approved examples: <strong>{feedback.correct.answers.join(" · ")}</strong>
            </p>
          )}
        </div>
      )}
      {feedback.explanation_ru && <p lang="ru" className="ru">{feedback.explanation_ru}</p>}
      <div className="actions">
        {incorrect && (
          <button className="btn" disabled={busy} onClick={onTryAgain}>
            Try again
          </button>
        )}
        <button className="btn btn-primary" disabled={busy} onClick={onContinue} data-testid="continue">
          Continue
        </button>
      </div>
    </div>
  );
}

function DashboardScreen({ dashboard, message, onStart, onStartCheck }: { dashboard: Dashboard; message: string | null; onStart: (blueprintRevisionId: string) => void; onStartCheck: (purpose: "diagnostic" | "heldout") => void }) {
  // lessons in course order: the first one that can still build a session is offered; the others stay one click away
  const [chosen, setChosen] = useState<string | null>(null);
  const bp = dashboard.blueprints.find((b) => b.blueprintRevisionId === chosen) ?? dashboard.blueprints.find((b) => b.readySessions > 0) ?? dashboard.blueprints[0];
  const others = dashboard.blueprints.filter((b) => b !== bp);
  return (
    <section aria-labelledby="dash-h">
      <h2 id="dash-h">Start practice</h2>
      {dashboard.banner && (
        <div className="notice notice-info" data-testid="banner">
          {dashboard.banner}
        </div>
      )}
      {message && (
        <div className="notice notice-error" role="alert">
          {message}
        </div>
      )}
      {dashboard.diagnostic.blocksUsed === 0 && dashboard.diagnostic.ready && (
        <div className="notice notice-info" data-testid="diagnostic-first">
          <p>
            <strong>New here?</strong> Start with the short diagnostic: 3 blocks of 8 tasks, about 10 minutes each. It shows which skills to practise first, and the lessons then give those skills more room. It is optional, and you can do one block now and the rest later.
          </p>
          <div className="actions">
            <button className="btn btn-primary" onClick={() => onStartCheck("diagnostic")}>
              Start the diagnostic
            </button>
          </div>
        </div>
      )}
      {!bp ? (
        <div className="card">
          <p>No approved lesson is published yet. Nothing to practise.</p>
          <p className="muted">This profile has no exercises yet. To load the first ten lessons, stop the server (<code>npm stop</code>), run <code>npm run first10:seed</code> and start again (<code>npm start</code>). Reviewed exercises from Content Studio are added here too.</p>
        </div>
      ) : (
        <div className="card">
          <h3>{bp.title}</h3>
          <p>
            {dashboard.taskCount} short exercises. No timer; skip or say “I don’t know” at any time.
          </p>
          <p className="muted" data-testid="ready">
            Ready sessions in the approved bank: <strong>{bp.readySessions}</strong>
          </p>
          {bp.shortage && bp.readySessions === 0 ? (
            <div className="notice notice-warn" data-testid="shortage" role="status">
              <p>
                <strong>Not enough approved exercises for {bp.shortage.requestedN} tasks.</strong>
              </p>
              <ul>
                {bp.shortage.deficits.map((d, i) => (
                  <li key={i}>{d.message}</li>
                ))}
              </ul>
              {bp.shortage.largestFeasibleN !== null ? <p>The bank would currently support a shorter session of {bp.shortage.largestFeasibleN} tasks (change the length in Settings), or choose another lesson below. New approved exercises come from Content Studio.</p> : <p>Choose another lesson below, or add reviewed exercises in Content Studio.</p>}
            </div>
          ) : null}
          <div className="actions">
            <button className="btn btn-primary" disabled={bp.readySessions === 0} onClick={() => onStart(bp.blueprintRevisionId)} data-testid="start">
              Start practice
            </button>
          </div>
          {others.length > 0 && (
            <details className="lessons" data-testid="other-lessons">
              <summary>Other lessons</summary>
              <ul>
                {others.map((o) => (
                  <li key={o.blueprintRevisionId}>
                    <button className="btn" disabled={o.readySessions === 0} onClick={() => setChosen(o.blueprintRevisionId)}>
                      {o.title}
                    </button>{" "}
                    <span className="muted small">{o.readySessions === 0 ? "no fresh exercises left" : `${o.readySessions} ready session${o.readySessions === 1 ? "" : "s"}`}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      <ChecksCard dashboard={dashboard} onStartCheck={onStartCheck} />
      <AgentTasks />
    </section>
  );
}

const HELDOUT_REASON: Record<string, string> = {
  no_skill_practised_for_7_days: "A delayed check needs a skill you practised at least 7 days ago. Keep practising and it will open.",
  not_enough_unseen_heldout_tasks: "There are not enough unseen check tasks for the skills that are due yet.",
};

function ChecksCard({ dashboard, onStartCheck }: { dashboard: Dashboard; onStartCheck: (purpose: "diagnostic" | "heldout") => void }) {
  const d = dashboard.diagnostic;
  const h = dashboard.heldout;
  return (
    <div className="card" data-testid="checks">
      <h3>Optional checks</h3>
      <p className="muted small">You never have to do these. They show where you really are, without hints, and the answers appear after each block.</p>
      <div className="check-row" data-testid="diagnostic-card">
        <strong>Starting diagnostic</strong>{" "}
        <span className="muted">— {d.blocksUsed} of {d.blocksTotal} blocks done · 8 mixed tasks per block, about 10 minutes</span>
        {d.nextBlock === null ? (
          <p className="muted small">All three blocks are done. Keep practising; delayed checks come later.</p>
        ) : d.ready ? (
          <div className="actions">
            <button className="btn" onClick={() => onStartCheck("diagnostic")} data-testid="start-diagnostic">Start block {d.nextBlock}</button>
          </div>
        ) : (
          <p className="notice notice-warn small" role="status" data-testid="diagnostic-shortage">There are not enough approved diagnostic tasks for the next block yet.</p>
        )}
      </div>
      <div className="check-row" data-testid="heldout-card">
        <strong>Delayed check</strong> <span className="muted">— skills you practised at least {h.minDelayDays} days ago, new sentences only</span>
        {h.ready ? (
          <div className="actions">
            <button className="btn" onClick={() => onStartCheck("heldout")} data-testid="start-heldout">Start a check of {h.availableTasks} tasks</button>
          </div>
        ) : (
          <p className="muted small" data-testid="heldout-reason">{(h.reason && HELDOUT_REASON[h.reason]) ?? "Not available yet."}</p>
        )}
      </div>
    </div>
  );
}

function BlockReview({ sessionId }: { sessionId: string }) {
  const [rows, setRows] = useState<Array<{ f: FeedbackResponse; verdict: string }> | null>(null);
  useEffect(() => {
    let off = false;
    const load = async () => {
      const snap = await api.fetchSession(sessionId);
      const out: Array<{ f: FeedbackResponse; verdict: string }> = [];
      for (const s of snap.slots) {
        try {
          out.push({ f: await api.fetchFeedback(sessionId, s.slotId), verdict: s.latest?.verdict ?? "" });
        } catch {
          /* an unanswered, unskipped task has no feedback */
        }
      }
      if (!off) setRows(out);
    };
    void load().catch(() => undefined);
    const timer = window.setInterval(() => void load().catch(() => undefined), 5000);
    return () => {
      off = true;
      window.clearInterval(timer);
    };
  }, [sessionId]);
  if (!rows || rows.length === 0) return null;
  return (
    <div className="card" data-testid="block-review">
      <h3>Your answers</h3>
      <p className="muted small">AI suggestions are provisional and may be wrong. They check grammar, not whether your answer matches the task.</p>
      <ol className="review-list">
        {rows.map(({ f }, i) => (
          <li key={f.slotId} data-verdict={f.verdict ?? ""}>
            <p><strong>{f.prompt}</strong></p>
            <p className="small">{f.verdict === "correct" ? "Correct." : f.verdict === "incorrect" ? "Not this time." : f.verdict === "idk" ? "You said you did not know." : f.state === "skipped" ? "Skipped." : "Saved for review."}</p>
            {f.correct?.noMistake && <p className="small">No mistake — the sentence is correct.</p>}
            {f.correct?.options && <p className="small">Correct: <strong>{f.correct.options.join(" / ")}</strong></p>}
            {f.correct?.segments && <p className="small">The mistake: <strong>{f.correct.segments.join(" / ")}</strong>{f.correct.corrections && f.correct.corrections.length > 0 ? <> → <strong>{f.correct.corrections.join(" / ")}</strong></> : null}</p>}
            {f.correct?.answers && <p className="small">Approved examples: <strong>{f.correct.answers.join(" · ")}</strong></p>}
            {f.explanation_ru && <p lang="ru" className="ru small">{f.explanation_ru}</p>}
            {f.aiReview && <div className="notice notice-info" data-testid="ai-review">
              <strong>AI draft — not a confirmed assessment</strong>
              <p lang="ru" className="ru small">{f.aiReview.explanation_ru}</p>
              {f.aiReview.findings.map((finding, index) => <p className="small" key={index}><strong>{finding.original}</strong> → <strong>{finding.suggestion}</strong> <span lang="ru">{finding.explanation_ru}</span></p>)}
            </div>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function SummaryScreen({ summary, onDone }: { summary: SessionSummary; onDone: () => void }) {
  const c = summary.counts;
  return (
    <section aria-labelledby="sum-h" data-testid="summary">
      <h2 id="sum-h">{summary.status === "completed" ? "Session complete" : "Session ended early"}</h2>
      <p className="muted">First attempts only. Pending answers are not wrong; skipped exercises are not mistakes.</p>
      <table className="summary-table">
        <caption className="visually-hidden">Session summary by outcome</caption>
        <tbody>
          <tr><th scope="row">Correct</th><td data-testid="count-correct">{c.correct}</td></tr>
          <tr><th scope="row">Not this time</th><td data-testid="count-incorrect">{c.incorrect}</td></tr>
          <tr><th scope="row">“I don’t know”</th><td data-testid="count-idk">{c.idk}</td></tr>
          <tr><th scope="row">With a hint or answer shown</th><td data-testid="count-assisted">{c.assisted}</td></tr>
          <tr><th scope="row">Unconfirmed answers</th><td data-testid="count-pending">{c.pending}</td></tr>
          <tr><th scope="row">Skipped</th><td data-testid="count-skipped">{c.skipped}</td></tr>
          {c.unanswered > 0 && <tr><th scope="row">Not reached</th><td data-testid="count-unanswered">{c.unanswered}</td></tr>}
        </tbody>
      </table>
      {summary.notes.map((n, i) => (
        <p key={i} className="muted">{n}</p>
      ))}
      <p className="muted">A written answer that is not an approved sentence remains unconfirmed. AI suggestions appear below when ready.</p>
      <BlockReview sessionId={summary.sessionId} />
      <div className="actions">
        <button className="btn btn-primary" onClick={onDone} data-testid="done">
          Back to start
        </button>
      </div>
    </section>
  );
}

const isShort = (format: string): boolean => format === "guided_short_answer" || format === "russian_to_english_short";

function errorText(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message;
  return e instanceof Error ? e.message : "Something went wrong.";
}
