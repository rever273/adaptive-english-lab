import type { Dashboard, FeedbackResponse, RevealResponse, SessionSnapshot, SessionSummary } from "@english-lab/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import { ApiRequestError } from "../api";
import { PromptView } from "../components/PromptView";
import { useVoice } from "../voice";
import { Kbd, isPressable, isTextField, useKeys } from "../components/hotkeys";
import { AgentTasks } from "../components/AgentTasks";
import { AUTO_ADVANCE_MS, diagnosticFinished, isShortFormat, noSpeechLeft, shouldAutoAdvance, shouldPreloadSpeech, unconfirmedLabel } from "../practiceFlow";

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

/**
 * The practice screen for both journeys. `grammar` (default) is the lesson dashboard and its sessions; `vocabulary` runs one vocabulary
 * session started from the Vocabulary page and hands control back with `onExit` (the two never resume each other's session).
 */
export function Practice({ category = "grammar", onExit, onNavigate }: { category?: api.SessionCategory; onExit?: () => void; onNavigate?: (page: "vocabulary" | "analytics") => void } = {}) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [otherActive, setOtherActive] = useState<{ sessionId: string; category: api.SessionCategory } | null>(null);
  const [slotUi, setSlotUi] = useState<SlotUi>(emptySlot);
  const [readOnly, setReadOnly] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [stt, setStt] = useState<{ ready: boolean; known: boolean }>({ ready: false, known: false });
  const [recent, setRecent] = useState<SessionSummary | null>(null);
  useEffect(() => {
    void api.fetchCapabilities().then((c) => setStt({ ready: c.stt.status === "ready", known: true })).catch(() => setStt({ ready: false, known: true }));
  }, []);
  const tab = useRef(tabId());

  const loadDashboard = useCallback(async (message: string | null = null) => {
    try {
      const current = await api.fetchCurrentSession(category);
      if (current.session) {
        setView({ kind: "session", session: current.session });
        return;
      }
      if (category === "vocabulary") {
        onExit?.(); // nothing open: back to the dictionary
        return;
      }
      setOtherActive(current.otherActive ?? null);
      const [dashboard, last] = await Promise.all([api.fetchDashboard(), api.fetchRecentSession("grammar")]);
      setRecent(last);
      setView({ kind: "dashboard", dashboard, message });
    } catch (e) {
      setView({ kind: "dashboard", dashboard: { activeSessionId: null, taskCount: 0, blueprints: [], banner: null, diagnostic: { protocol: "diagnostic-v1", blocksTotal: 3, blocksUsed: 0, nextBlock: null, ready: false, shortage: null }, heldout: { protocol: "heldout-v1", availableTasks: 0, eligibleSkills: 0, minDelayDays: 7, ready: false, reason: null } }, message: errorText(e) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

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

  // a new task never inherits the previous task's voice draft
  useEffect(() => {
    voice.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSlotId]);

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

  // Voice is for the lesson practice only (a diagnostic or delayed check is typed, so its baseline is honest). TASK_021 T1: the speech model is loaded
  // while the exercise BEFORE a voice one is on screen (or at the start, if the first one is), so the microphone is ready the moment it is pressed.
  const voiceUsable = category === "grammar" && view.kind === "session" && view.session.purpose === "practice" && stt.ready;
  const slotList = view.kind === "session" ? view.session.slots : null;
  useEffect(() => {
    if (!voiceUsable || readOnly || !slotList) return;
    if (shouldPreloadSpeech(slotList, slotList.findIndex((s) => s.slotId === openSlotId))) voice.prepare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceUsable, readOnly, openSlotId, sessionId]);

  // T3a: once no exercise is left where the microphone could be used (or voice is not available at all) and an answer exists, the speech model is
  // freed and the local AI checks of the written answers start - not only at "Session complete". Sent once per session; the server call is idempotent.
  const voiceReleased = useRef<string | null>(null);
  useEffect(() => {
    if (!slotList || !sessionId || category !== "grammar" || !stt.known || voiceReleased.current === sessionId) return;
    if (!slotList.some((s) => s.attempts > 0)) return;
    if (voiceUsable && !noSpeechLeft(slotList)) return;
    voiceReleased.current = sessionId;
    void api.voiceDone(sessionId).catch(() => {
      voiceReleased.current = null; // try again on the next change
    });
  }, [slotList, sessionId, voiceUsable, stt.known]);

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
        if (type === "continue") api.announceXp(); // a finished task may have earned XP: the header refreshes now
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

  // every task closed: go straight to the results (nothing is left to choose on that screen)
  const everyTaskClosed = view.kind === "session" && view.session.progress.total > 0 && view.session.progress.closed === view.session.progress.total;
  const autoFinished = useRef<string | null>(null);
  useEffect(() => {
    if (view.kind !== "session" || !everyTaskClosed || autoFinished.current === view.session.sessionId) return;
    autoFinished.current = view.session.sessionId;
    void finish("completed");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everyTaskClosed, sessionId]);

  // after an answer: Enter goes on, T tries again (only when the answer was wrong); never while typing, never on a focused button
  const goOn = () => void act(slotUi.feedback?.verdict != null || slotUi.feedback?.state === "closed" ? "continue" : "skip");
  const tryAgain = () => {
    setRetry((r) => r + 1);
    setSlotUi((u) => ({ ...u, feedback: null }));
  };
  // T2: a plainly correct answer moves on by itself after a short, visible confirmation; Esc or "Stay here" keeps the screen. Everything else keeps Continue.
  const [stay, setStay] = useState<string | null>(null);
  const autoPending = slotUi.feedback !== null && !slotUi.busy && !slotUi.error && stay !== slotUi.feedback.slotId && shouldAutoAdvance(slotUi.feedback, { hintUsed: slotUi.hint !== null, vocabulary: category === "vocabulary" });
  const autoSlotId = autoPending ? slotUi.feedback!.slotId : null;
  useEffect(() => {
    if (!autoSlotId) return;
    const timer = window.setTimeout(() => void act("continue"), AUTO_ADVANCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSlotId]);
  useKeys((e) => {
    if (e.key === "Escape" && autoSlotId) setStay(autoSlotId);
    if (view.kind !== "session" || !slotUi.feedback || slotUi.busy || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTextField(e.target)) return;
    if (e.key === "Enter") {
      if (isPressable(e.target)) return;
      e.preventDefault();
      goOn();
    } else if (e.key.toLowerCase() === "t" && (slotUi.feedback.verdict === "incorrect" || slotUi.feedback.verdict === "idk")) {
      e.preventDefault();
      tryAgain();
    }
  });

  if (view.kind === "loading") return <p role="status">Loading…</p>;

  if (view.kind === "summary") {
    return <SummaryScreen summary={view.summary} onDone={() => (category === "vocabulary" ? onExit?.() : void loadDashboard())} onNavigate={onNavigate} />;
  }

  if (view.kind === "dashboard") {
    return <>{otherActive?.category === "vocabulary" && (
      <div className="notice notice-info" role="status" data-testid="other-active">
        <i className="pi pi-bookmark" aria-hidden="true" /> A vocabulary session is still open. Finish it in Vocabulary before starting a grammar lesson.
        {onNavigate && <div className="actions"><button className="btn btn-primary" onClick={() => onNavigate("vocabulary")}><i className="pi pi-arrow-right" aria-hidden="true" /> Continue the vocabulary session</button></div>}
      </div>
    )}<DashboardScreen dashboard={view.dashboard} message={view.message} onStart={(id) => void start(id)} onStartCheck={(p) => void startCheck(p)} />{recent && <div className="actions page-actions"><button className="btn" data-testid="review-recent" onClick={() => setView({ kind: "summary", summary: recent })}><i className="pi pi-history" aria-hidden="true" /> Review last session</button></div>}</>;
  }

  const session = view.session;
  const allClosed = session.progress.closed === session.progress.total;
  const answered = slotUi.feedback !== null;
  const repeatInfo = slotUi.reveal ? session.slots.find((x) => x.slotId === slotUi.reveal!.slotId)?.repeat : undefined;

  return (
    <section aria-labelledby="practice-h">
      <header className="session-header">
        <h2 id="practice-h">{category === "vocabulary" ? <><i className="pi pi-bookmark" aria-hidden="true" /> Vocabulary practice</> : session.purpose === "diagnostic" ? "Starting diagnostic" : session.purpose === "heldout" ? "Delayed check" : "Practice"}</h2>
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

      {allClosed && !slotUi.error ? (
        <p role="status" data-testid="wrapping-up"><i className="pi pi-spin pi-spinner" aria-hidden="true" /> Preparing your results…</p>
      ) : allClosed ? (
        <div className="card" data-testid="all-closed">
          <h3><i className="pi pi-flag-fill" aria-hidden="true" /> All exercises are done</h3>
          <p>You can finish now to see your summary.</p>
          <button className="btn btn-primary" onClick={() => void finish("completed")}>
            Finish and see summary
          </button>
        </div>
      ) : slotUi.reveal ? (
        <div className={`card task ${category === "vocabulary" ? `vfmt-${slotUi.reveal.format}` : `fmt-${slotUi.reveal.format}`}`} data-testid="slot" data-format={slotUi.reveal.format} data-slot-id={slotUi.reveal.slotId}>
          {slotUi.reveal.inputPreference === "voice" && isShortFormat(slotUi.reveal.format) && (
            <p className="badge badge-info" data-testid="voice-note">
              <i className={`pi ${stt.ready ? "pi-microphone" : "pi-ban"}`} aria-hidden="true" /> {stt.ready ? "You can speak this one: press “Speak instead”." : "Voice is not available on this computer right now. Please type your answer."}
            </p>
          )}
          {repeatInfo && (
            <p className="badge badge-info small" data-testid="repeat-label" title={repeatInfo.reason === "missed" ? "You missed this sentence last time." : repeatInfo.reason === "assisted" ? "You used help on this sentence last time." : "Coming back for review."}>
              <i className="pi pi-replay" aria-hidden="true" /> Repeat - you have seen this sentence
            </p>
          )}
          <PromptView
            checkMode={session.purpose !== "practice"}
            vocabulary={category === "vocabulary"}
            key={`${slotUi.reveal.slotId}-${retry}`}
            reveal={slotUi.reveal}
            busy={slotUi.busy || readOnly !== null}
            locked={answered && !slotUi.pendingSubmission}
            hint={slotUi.hint}
            voice={isShortFormat(slotUi.reveal.format) && voiceUsable ? voice : undefined}
            onSubmit={(a, d) => void submit(a, false, d)}
            onIdk={() => void submit(undefined, true)}
            onSkip={() => void act("skip")}
            onHint={() => void act("hint")}
            onShowAnswer={() => void showAnswerAndContinue()}
          />
          {slotUi.feedback && <FeedbackPanel feedback={slotUi.feedback} busy={slotUi.busy} onTryAgain={tryAgain} onContinue={goOn} autoAdvance={autoPending} onStay={() => setStay(slotUi.feedback!.slotId)} />}
          {slotUi.error && (
            <div className="notice notice-error" role="alert" data-testid="error">
              {slotUi.error}
            </div>
          )}
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

/** the first occurrence of `needle` in `text` coloured (case-insensitive); the text as it is when it does not occur */
function Marked({ text, needle, cls = "hl" }: { text: string; needle: string | null; cls?: string }) {
  const i = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (!needle || i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className={cls}>{text.slice(i, i + needle.length)}</mark>
      {text.slice(i + needle.length)}
    </>
  );
}

/** vocabulary feedback: the word and its Russian on their own line, then the finished sentence (word coloured) and its Russian translation */
function VocabSentence({ v }: { v: NonNullable<FeedbackResponse["vocabulary"]> }) {
  return (
    <div className="vocab-sentence" data-testid="vocab-sentence">
      <p className="vocab-word" data-testid="vocab-word">
        <i className="pi pi-bookmark-fill" aria-hidden="true" /> <strong>{v.lemma}</strong> <span className="muted small">{v.partOfSpeech}</span> — {v.translationRu ? <span lang="ru" className={`vt${v.translationSource === "ai_draft" ? " ai-text" : ""}`} title={v.translationSource === "ai_draft" ? "Written by the local AI" : undefined}>{v.translationRu}</span> : <span className="muted">no translation yet</span>}
      </p>
      {v.sentence && (
        <p className="vocab-line">
          <Marked text={v.sentence.before} needle={v.sentence.form} cls="hl hl-soft" />
          <mark className="hl">{v.sentence.filled}</mark>
          <Marked text={v.sentence.after} needle={v.sentence.form} cls="hl hl-soft" />
        </p>
      )}
      {v.sentenceRu && (
        <p lang="ru" className="ru vocab-line vocab-line-ru">
          <Marked text={v.sentenceRu} needle={v.wordRu} />
        </p>
      )}
    </div>
  );
}

const FAMILY_NAME: Record<string, string> = { recognition: "word in context", guided_recall: "recall", collocation: "collocation" };

/** vocabulary: the reviewed reason for every option - why the right one fits here and why each other one does not (details on demand) */
function VocabWhy({ v, compact = false }: { v: NonNullable<FeedbackResponse["vocabulary"]>; compact?: boolean }) {
  const chosenWrong = v.options.find((o) => o.chosen && !o.correct);
  return (
    <div className="vocab-why" data-testid="vocab-why">
      <p className="small muted">
        <i className="pi pi-bookmark" aria-hidden="true" /> <strong>{v.lemma}</strong> · {v.partOfSpeech} · {FAMILY_NAME[v.family] ?? v.family}
      </p>
      {chosenWrong && !compact && <p lang="ru" className="ru small"><strong>{chosenWrong.text}</strong>: {chosenWrong.rationaleRu}</p>}
      {v.options.length > 0 && (
        <details>
          <summary className="small">Why? All options</summary>
          <ul className="why-list">
            {v.options.map((o) => (
              <li key={o.text} className={o.correct ? "why-ok" : "why-no"}>
                <i className={`pi ${o.correct ? "pi-check" : "pi-times"}`} aria-hidden="true" /> <strong>{o.text}</strong>{o.chosen && <span className="muted small"> (your choice)</span>} — <span lang="ru">{o.rationaleRu}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** D64: the learner's sentence with the name/number that differs from the task marked in red */
function DetailDiff({ d }: { d: NonNullable<FeedbackResponse["detail"]> }) {
  return (
    <div className="detail-diff" data-testid="detail-diff">
      <p>
        {d.tokens.map((t, i) => (
          <span key={i}>
            {i > 0 && " "}
            {t.differs ? <mark className="diff-bad" title="Different from the task">{t.text}</mark> : t.text}
          </span>
        ))}
      </p>
      <p className="small">
        The task asked for <strong className="diff-good">{d.expected.join(", ")}</strong>. Your construction is right and counts for this skill; only this detail is a slip.
      </p>
    </div>
  );
}

function FeedbackPanel({ feedback, busy, onTryAgain, onContinue, autoAdvance = false, onStay }: { feedback: FeedbackResponse; busy: boolean; onTryAgain: () => void; onContinue: () => void; autoAdvance?: boolean; onStay?: () => void }) {
  const incorrect = feedback.verdict === "incorrect" || feedback.verdict === "idk";
  const kind = feedback.state === "pending" ? "pending" : feedback.detail ? "detail" : feedback.verdict === "correct" ? "ok" : incorrect ? "again" : "info";
  return (
    <div className={`feedback feedback-${kind}`} data-testid="feedback" data-state={feedback.state} data-verdict={feedback.verdict ?? ""} aria-live="polite">
      <p className="feedback-title">
        <i className={`pi ${feedback.state === "closed" ? "pi-save" : feedback.state === "pending" ? "pi-hourglass" : feedback.verdict === "correct" ? "pi-check-circle" : feedback.verdict === "idk" ? "pi-info-circle" : feedback.verdict === "incorrect" ? "pi-times-circle" : "pi-info-circle"}`} aria-hidden="true" />{" "}
        {feedback.state === "closed" ? "Saved" : feedback.aiChecked ? `${feedback.verdict === "correct" ? "Correct" : "Incorrect"} (checked by AI)` : feedback.unresolved ? "Could not be checked automatically" : feedback.state === "pending" ? "Saved — AI review later" : feedback.detail ? "Right construction — check the detail" : feedback.verdict === "correct" ? "Correct" : feedback.verdict === "idk" ? "No problem" : feedback.verdict === "incorrect" ? "Not this time" : feedback.state === "skipped" ? "Skipped" : "Answer"}
      </p>
      {feedback.detail ? <DetailDiff d={feedback.detail} /> : feedback.aiChecked && feedback.aiReview ? <p lang="ru" className="ru" data-testid="ai-reason">{feedback.aiReview.explanation_ru}</p> : <p>{feedback.message}</p>}
      {feedback.aiChecked && <p className="muted small">The local AI made this call, so it counts in your progress with a lower weight until it is confirmed.</p>}
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
      {feedback.vocabulary && <VocabSentence v={feedback.vocabulary} />}
      {feedback.vocabulary && <VocabWhy v={feedback.vocabulary} />}
      {autoAdvance && <p className="muted small" data-testid="auto-advance">Next exercise in a moment. <button type="button" className="link" onClick={onStay} data-testid="stay">Stay here</button> (Esc)</p>}
      <div className="actions">
        {incorrect && (
          <button className="btn has-kbd" disabled={busy} onClick={onTryAgain}>
            <Kbd k="T" />
            <i className="pi pi-replay" aria-hidden="true" /> Try again
          </button>
        )}
        <button className="btn btn-primary has-kbd" disabled={busy} onClick={onContinue} data-testid="continue" autoFocus>
          <Kbd k="Enter" />
          Continue <i className="pi pi-arrow-right" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** D65: ONE non-blocking notice once enough answers could not be checked automatically; one button copies the single agent task for them. */
function ReviewNotice({ unresolved }: { unresolved: number }) {
  const [state, setState] = useState<{ text: string; copied: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const copy = async () => {
    setError(null);
    try {
      const { text } = await api.fetchAgentTask("review");
      let copied = true;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        copied = false;
      }
      setState({ text, copied });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="notice notice-info" data-testid="review-notice">
      <p>
        <i className="pi pi-hourglass" aria-hidden="true" /> <strong>{unresolved} answers are waiting for a review.</strong> Some could not be checked automatically (not marked wrong); some the local AI called incorrect (shown as Incorrect, but they count in your progress only after review). Copy one task for your coding agent: it confirms or overturns each answer and adds the ones that are fine as approved variants, so they are recognised next time.
      </p>
      <div className="actions">
        <button className="btn" onClick={() => void copy()} data-testid="copy-review-task">
          <i className="pi pi-copy" aria-hidden="true" /> Copy task for my agent
        </button>
      </div>
      {error && <p className="notice notice-error small" role="alert">{error}</p>}
      {state && (
        <div>
          <p className="small" role="status">{state.copied ? "Copied. Paste it into your agent's chat." : "Could not use the clipboard. Select and copy the text below."}</p>
          <textarea readOnly rows={5} value={state.text} aria-label="Agent task text" style={{ width: "100%" }} />
        </div>
      )}
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
      {dashboard.review?.notice && <ReviewNotice unresolved={dashboard.review.unresolved} />}
      {!diagnosticFinished(dashboard.diagnostic) && dashboard.diagnostic.blocksUsed === 0 && dashboard.diagnostic.ready && (
        <div className="notice notice-info" data-testid="diagnostic-first">
          <p>
            <strong>New here?</strong> Start with the short diagnostic: 3 blocks of 8 tasks, about 10 minutes each. It shows which skills to practise first, and the lessons then give those skills more room. It is optional, and you can do one block now and the rest later.
          </p>
          <div className="actions">
            <button className="btn btn-primary" onClick={() => onStartCheck("diagnostic")}>
              <i className="pi pi-compass" aria-hidden="true" /> Start the diagnostic
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
          <h3><i className="pi pi-book" aria-hidden="true" /> {bp.title}</h3>
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
              <i className="pi pi-play" aria-hidden="true" /> Start practice
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
      <h3><i className="pi pi-compass" aria-hidden="true" /> Optional checks</h3>
      <p className="muted small">You never have to do these. They show where you really are, without hints, and the answers appear after each block.</p>
      {!diagnosticFinished(d) && <div className="check-row" data-testid="diagnostic-card">
        <strong>Starting diagnostic</strong>{" "}
        <span className="muted">— {d.blocksUsed} of {d.blocksTotal} blocks done · 8 mixed tasks per block, about 10 minutes</span>
        {d.ready ? (
          <div className="actions">
            <button className="btn" onClick={() => onStartCheck("diagnostic")} data-testid="start-diagnostic"><i className="pi pi-play" aria-hidden="true" /> Start block {d.nextBlock}</button>
          </div>
        ) : (
          <p className="notice notice-warn small" role="status" data-testid="diagnostic-shortage">There are not enough approved diagnostic tasks for the next block yet.</p>
        )}
      </div>}
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

/** how one answer is shown in a review: icon, colour and words agree with the summary counts (an AI opinion is never "Correct") */
function outcome(f: FeedbackResponse): { cls: string; icon: string; label: string } {
  if (f.state === "skipped") return { cls: "skip", icon: "pi-forward", label: "Skipped" };
  if (f.state === "pending" || f.confirmation !== "confirmed") {
    if (f.aiChecked) return { cls: f.verdict === "correct" ? "ok" : "bad", icon: f.verdict === "correct" ? "pi-check-circle" : "pi-times-circle", label: unconfirmedLabel(f) };
    return { cls: "wait", icon: "pi-hourglass", label: unconfirmedLabel(f) };
  }
  if (f.verdict === "correct" && f.detail) return { cls: "detail", icon: "pi-exclamation-circle", label: "Right construction — a detail differs" };
  if (f.verdict === "correct") return { cls: "ok", icon: "pi-check-circle", label: "Correct" };
  if (f.verdict === "incorrect") return { cls: "bad", icon: "pi-times-circle", label: "Not this time" };
  if (f.verdict === "idk") return { cls: "idk", icon: "pi-question-circle", label: "You said you did not know" };
  return { cls: "skip", icon: "pi-info-circle", label: "Answer shown" };
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
        {rows.map(({ f }) => {
          const o = outcome(f);
          return (
          <li key={f.slotId} data-verdict={f.verdict ?? ""} className={`review-item review-${o.cls}`}>
            <p className="review-head"><i className={`pi ${o.icon}`} aria-hidden="true" /> <span>{o.label}</span></p>
            <p><strong>{f.prompt}</strong></p>
            {f.detail ? <DetailDiff d={f.detail} /> : f.yourAnswer && <p className="small">Your answer: <strong>{f.yourAnswer}</strong></p>}
            {f.correct?.noMistake && <p className="small">Right answer: <strong>No mistake</strong> — the sentence is correct.</p>}
            {f.correct?.options && <p className="small">Right answer: <strong>{f.correct.options.join(" / ")}</strong></p>}
            {f.correct?.segments && <p className="small">The mistake: <strong>{f.correct.segments.join(" / ")}</strong>{f.correct.corrections && f.correct.corrections.length > 0 ? <> → <strong>{f.correct.corrections.join(" / ")}</strong></> : null}</p>}
            {f.correct?.answers && <p className="small">Approved sentences: <strong>{f.correct.answers.join(" · ")}</strong></p>}
            {f.explanation_ru && <p lang="ru" className="ru small">{f.explanation_ru}</p>}
            {f.vocabulary && <VocabWhy v={f.vocabulary} compact />}
            {f.aiReview && <div className="notice notice-info" data-testid="ai-review">
              <strong>{f.aiChecked ? "Checked by AI — counts with a lower weight until confirmed" : "AI draft — not a confirmed assessment"}</strong>
              <p lang="ru" className="ru small">{f.aiReview.explanation_ru}</p>
              {f.aiReview.findings.map((finding, index) => <p className="small" key={index}><strong>{finding.original}</strong> → <strong>{finding.suggestion}</strong> <span lang="ru">{finding.explanation_ru}</span></p>)}
            </div>}
          </li>
          );
        })}
      </ol>
    </div>
  );
}

function SummaryScreen({ summary: first, onDone, onNavigate }: { summary: SessionSummary; onDone: () => void; onNavigate?: (page: "vocabulary" | "analytics") => void }) {
  // T3c: the numbers were fixed at the moment the session ended; while local AI checks of its answers are still running they are re-read, so the counter counts down
  const [summary, setSummary] = useState(first);
  useEffect(() => setSummary(first), [first]);
  const waitingForAi = summary.aiWaiting ?? 0;
  useEffect(() => {
    if (waitingForAi <= 0) return;
    const timer = window.setInterval(() => void api.fetchSummary(summary.sessionId).then(setSummary).catch(() => undefined), 3000);
    return () => window.clearInterval(timer);
  }, [waitingForAi, summary.sessionId]);
  const c = summary.counts;
  const vocab = summary.category === "vocabulary";
  const ai = (summary.aiChecked?.correct ?? 0) + (summary.aiChecked?.incorrect ?? 0);
  return (
    <section aria-labelledby="sum-h" data-testid="summary">
      <h2 id="sum-h">{vocab ? "Vocabulary session " : "Session "}{summary.status === "completed" ? "complete" : "ended early"}</h2>
      {(summary.xpEarned ?? 0) > 0 && (
        <p className={`xp-earned xp-earned-${vocab ? "vocabulary" : "grammar"}`} data-testid="xp-earned">
          <i className={`pi ${vocab ? "pi-bookmark-fill" : "pi-pencil"}`} aria-hidden="true" /> +{summary.xpEarned} {vocab ? "Vocabulary" : "Grammar"} XP
          <span className="muted small"> · activity points for finished tasks, not a score</span>
        </p>
      )}
      <p className="muted">Your first try on each task. Skipped tasks and “I don’t know” are not mistakes.</p>
      <div className="stat-grid" role="list" aria-label="Session summary by outcome">
        <Stat cls="ok" icon="pi-check-circle" label="Correct" value={c.correct - (summary.detailDiffers ?? 0)} id="count-correct" />
        {(summary.detailDiffers ?? 0) > 0 && <Stat cls="detail" icon="pi-exclamation-circle" label="Right construction, a detail differs" value={summary.detailDiffers ?? 0} id="count-detail" />}
        <Stat cls="bad" icon="pi-times-circle" label="Not this time" value={c.incorrect} id="count-incorrect" />
        <Stat cls="idk" icon="pi-question-circle" label="“I don’t know”" value={c.idk} id="count-idk" />
        <Stat cls="info" icon="pi-lightbulb" label="With a hint or answer shown" value={c.assisted} id="count-assisted" />
        {waitingForAi > 0 && <Stat cls="wait" icon="pi-spin pi-spinner" label="AI check in progress" value={waitingForAi} id="count-ai-waiting" />}
        {ai > 0 && <Stat cls="info" icon="pi-sparkles" label="Counted, checked by AI (lower weight)" value={ai} id="count-ai-checked" />}
        {(summary.unresolved ?? 0) > 0 && <Stat cls="wait" icon="pi-hourglass" label="Waiting for review (not checked automatically, or AI-incorrect)" value={summary.unresolved ?? 0} id="count-unresolved" />}
        <Stat cls="wait" icon="pi-hourglass" label="Not counted yet" value={c.pending} id="count-pending" />
        <Stat cls="skip" icon="pi-forward" label="Skipped" value={c.skipped} id="count-skipped" />
        {c.unanswered > 0 && <Stat cls="skip" icon="pi-minus-circle" label="Not reached" value={c.unanswered} id="count-unanswered" />}
        {(summary.repeats ?? 0) > 0 && <Stat cls="info" icon="pi-replay" label="Of these, repeats (practice only, no change to skill levels)" value={summary.repeats ?? 0} id="count-repeats" />}
      </div>
      {summary.notes.map((n, i) => (
        <p key={i} className="muted">{n}</p>
      ))}
      {c.pending > 0 && (
        <p className="notice notice-warn small">
          <i className="pi pi-hourglass" aria-hidden="true" /> <strong>Not counted yet</strong> means the local AI is still checking a sentence that is worded differently from the approved ones, or it could not decide (&ldquo;Could not be checked automatically&rdquo;). Those wait for a review and are never marked wrong. When the AI does decide, you see &ldquo;Correct&rdquo; or &ldquo;Incorrect (checked by AI)&rdquo; with its reason, and the answer counts with a lower weight until it is confirmed. (A different name or number alone is recognised automatically.)
        </p>
      )}
      {vocab && (summary.practiseAgain ?? []).length > 0 && (
        <p className="notice notice-info" data-testid="practise-again">
          <i className="pi pi-replay" aria-hidden="true" /> Worth another look: {(summary.practiseAgain ?? []).map((w, i) => <strong key={w}>{i > 0 ? ", " : ""}{w}</strong>)}. They will come back in new sentences.
        </p>
      )}
      <BlockReview sessionId={summary.sessionId} />
      <div className="actions">
        <button className="btn btn-primary" onClick={onDone} data-testid="done">
          <i className={`pi ${vocab ? "pi-bookmark" : "pi-home"}`} aria-hidden="true" /> {vocab ? "Back to Vocabulary" : "Back to start"}
        </button>
        {vocab && onNavigate && (
          <button className="btn" onClick={() => onNavigate("analytics")}>
            <i className="pi pi-chart-line" aria-hidden="true" /> Vocabulary analytics
          </button>
        )}
      </div>
    </section>
  );
}

function Stat({ cls, icon, label, value, id }: { cls: string; icon: string; label: string; value: number; id: string }) {
  return (
    <div className={`stat stat-${cls}${value === 0 ? " stat-zero" : ""}`} role="listitem">
      <i className={`pi ${icon}`} aria-hidden="true" />
      <span className="stat-value" data-testid={id}>{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function errorText(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message;
  return e instanceof Error ? e.message : "Something went wrong.";
}
