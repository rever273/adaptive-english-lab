import { usePracticeActivity } from "../practiceActivity";
import { PauseOverlay, useAutoPause } from "../components/Pause";
import { MyThoughts } from "../components/MyThoughts.js";
import type { Dashboard, FeedbackResponse, RevealResponse, SessionSnapshot, SessionSummary } from "@english-lab/contracts";
import { MAX_LESSON_PLAYS } from "@english-lab/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import { ApiRequestError } from "../api";
import { WordImage } from "../components/WordImage";
import { PromptView } from "../components/PromptView";
import { MatchGame } from "../components/MatchGame";
import { MIN_WORDS, type MatchMode } from "../game/matchEngine";
import { useVoice } from "../voice";
import { isPressable, isTextField, useKeys } from "../components/hotkeys";
import { AI_CHECK_WAIT_S, AUTO_ADVANCE_MS, isShortFormat, noSpeechLeft, shouldAutoAdvance, shouldPreloadSpeech } from "../practiceFlow";
import { feedbackSound, playPracticeSound } from "../practiceSounds";
import { DailyGoalCheck } from "../components/DailyGoalNotice";
import { FeedbackPanel } from "./practice/FeedbackPanel";
import { DashboardScreen } from "./practice/DashboardScreen";
import { SummaryScreen } from "./practice/SummaryScreen";

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
  translation: string | null;
  letters: Array<string | null> | null;
  /** the attempt id of a submission that has not been confirmed yet; reused on retry so it never double-counts */
  pendingSubmission: { id: string; answer?: string | string[]; idk?: boolean; transcriptId?: string } | null;
  busy: boolean;
  /** the answer is saved and the local AI is judging it: the verdict is awaited here instead of being shown as "later" */
  checking: boolean;
  error: string | null;
};
const emptySlot: SlotUi = { reveal: null, feedback: null, hint: null, translation: null, letters: null, pendingSubmission: null, busy: false, checking: false, error: null };

/**
 * The practice screen for both journeys. `grammar` (default) is the lesson dashboard and its sessions; `vocabulary` runs one vocabulary
 * session started from the Vocabulary page and hands control back with `onExit` (the two never resume each other's session).
 */
export function Practice({ category = "grammar", onExit, onNavigate, dailyStart = false, onDailyDone }: { category?: api.SessionCategory; onExit?: () => void; onNavigate?: (page: "vocabulary" | "analytics" | "studio") => void; dailyStart?: boolean; onDailyDone?: () => void } = {}) {
  const [stockBlock, setStockBlock] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [otherActive, setOtherActive] = useState<{ sessionId: string; category: api.SessionCategory } | null>(null);
  const [slotUi, setSlotUi] = useState<SlotUi>(emptySlot);
  const [readOnly, setReadOnly] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [stt, setStt] = useState<{ ready: boolean; known: boolean }>({ ready: false, known: false });
  const [recent, setRecent] = useState<SessionSummary | null>(null);
  const [soundsEnabled, setSoundsEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    const loadSounds = () => { void api.fetchSettings().then(settings => { if (active) setSoundsEnabled(settings.values.practiceSoundsEnabled ?? true); }).catch(() => {}); };
    loadSounds();
    window.addEventListener("focus", loadSounds);
    return () => { active = false; window.removeEventListener("focus", loadSounds); };
  }, []);
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
  // a hidden tab or two minutes without activity pauses the practice clock and covers the screen until the learner comes back
  const autoPause = useAutoPause(view.kind === "session" && view.session.purpose === "practice" && !readOnly);
  usePracticeActivity(sessionId, tab.current, view.kind === "session" && view.session.purpose === "practice" && !!slotUi.reveal && !readOnly && !autoPause.reason);
  const voice = useVoice(sessionId, tab.current, stt.ready);
  const spokenSlots = useRef(new Set<string>());
  const speechSlot = category === "vocabulary" && slotUi.feedback?.correct && slotUi.feedback.vocabulary ? slotUi.feedback.slotId : null;
  useEffect(() => {
    if (!sessionId || !speechSlot || spokenSlots.current.has(speechSlot)) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    let audio: HTMLAudioElement | null = null;
    const timer = window.setTimeout(() => {
      spokenSlots.current.add(speechSlot);
      void api.vocabularySpeech(sessionId, speechSlot, controller.signal).then((blob) => {
      if (!blob || controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      audio = new Audio(objectUrl);
      void audio.play().catch(() => {});
      }).catch(() => {});
    }, 350); // let the short feedback chime finish before vocabulary pronunciation
    return () => { window.clearTimeout(timer); controller.abort(); audio?.pause(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [sessionId, speechSlot]);
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
  const activeSlot = useRef<string | null>(null);
  activeSlot.current = openSlotId;
  useEffect(() => () => { activeSlot.current = null; }, []);
  const completionSoundSession = useRef<string | null>(null);

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
        if (!cancelled) setSlotUi({ ...emptySlot, reveal, feedback, hint: reveal.lastHint ?? null });
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
      setStockBlock(null);
      setView({ kind: "session", session: snapshot });
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === "SESSION_ACTIVE") return loadDashboard();
      if (e instanceof ApiRequestError && e.code === "LESSON_STOCK_LOW") { setStockBlock(e.message); return loadDashboard(); }
      await loadDashboard(e instanceof ApiRequestError && e.code === "CONTENT_SHORTAGE" ? null : errorText(e));
    }
  }

  const dailyStarted = useRef(false);
  useEffect(() => {
    if (!dailyStart || category !== "grammar" || dailyStarted.current || view.kind !== "dashboard") return;
    dailyStarted.current = true;
    const next = view.dashboard.blueprints.find(b => b.unlocked && b.completed < MAX_LESSON_PLAYS && b.readySessions > 0);
    if (next) void start(next.blueprintRevisionId);
  }, [dailyStart, category, view]);

  /** the summary's "Next session": another session of the same kind (the next ready grammar lesson, or a new vocabulary session) */
  async function nextSession() {
    if (category === "vocabulary") {
      try { await api.createVocabSession(); } catch { onExit?.(); return; }
      await loadDashboard(); // picks up the session just opened
      return;
    }
    try {
      const d = await api.fetchDashboard();
      const next = d.blueprints.find(b => b.unlocked && b.completed < MAX_LESSON_PLAYS && b.readySessions > 0);
      if (next) await start(next.blueprintRevisionId);
      else await loadDashboard();
    } catch (e) { await loadDashboard(errorText(e)); }
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
    // the server stores a confirmed transcript trimmed and requires the submitted answer to equal it exactly
    if (voiceDraftId && typeof answer === "string") answer = answer.trim();
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
      const slotId = slotUi.reveal.slotId;
      let feedback = await api.fetchFeedback(sessionId, slotId);
      await refresh();
      // an answer the code could not judge goes to the local AI at once (speech runs in the cloud, so the card is free): wait for its verdict here
      const undecided = (f: FeedbackResponse) => f.state === "pending" && !f.aiChecked && !f.unresolved && (f.verdict === "pending" || f.verdict === "ambiguous");
      if (undecided(feedback)) {
        setSlotUi((u) => ({ ...u, pendingSubmission: null, checking: true }));
        for (let i = 0; i < AI_CHECK_WAIT_S && undecided(feedback); i++) {
          await new Promise((r) => setTimeout(r, 1000));
          feedback = await api.fetchFeedback(sessionId, slotId);
        }
      }
      const sound = submission.idk ? null : feedbackSound(feedback);
      if (sound && activeSlot.current === slotId) playPracticeSound(sound, soundsEnabled);
      setSlotUi((u) => (u.reveal?.slotId === slotId ? { ...u, busy: false, checking: false, pendingSubmission: null, feedback } : u));
    } catch (e) {
      // not saved (yet): the same submissionId is retried, so a flaky connection can never double-count an answer
      // the confirmed transcript is stored trimmed: a retry with the same (untrimmed) text would fail forever, so retry with the trimmed text
      const mismatch = e instanceof ApiRequestError && e.code === "TRANSCRIPT_MISMATCH" && typeof submission.answer === "string";
      setSlotUi((u) => ({ ...u, busy: false, checking: false, ...(mismatch ? { pendingSubmission: { ...submission, answer: (submission.answer as string).trim() } } : {}), error: `Unsaved: ${errorText(e)} Your answer is kept here; press the button again to retry.` }));
    }
  }

  async function act(type: "hint" | "vocabulary_translation" | "vocabulary_letters" | "reveal_answer" | "skip" | "continue", letterIndex?: number) {
    if (!sessionId || !slotUi.reveal) return;
    setSlotUi((u) => ({ ...u, busy: true, error: null }));
    try {
      const ev = await api.sendEvent(sessionId, slotUi.reveal.slotId, type, letterIndex);
      if (type === "hint") setSlotUi((u) => ({ ...u, busy: false, hint: ev.hint ?? "No more hints for this exercise.", reveal: u.reveal ? { ...u.reveal, hintsAvailable: Math.max(0, u.reveal.hintsAvailable - 1) } : null }));
      else if (type === "vocabulary_letters") setSlotUi((u) => ({ ...u, busy: false, letters: ev.letters ?? null }));
      else if (type === "vocabulary_translation") setSlotUi((u) => ({ ...u, busy: false, translation: ev.hint ?? "Translation unavailable for this exercise." }));
      else if (type === "reveal_answer") {
        const feedback = await api.fetchFeedback(sessionId, slotUi.reveal.slotId);
        setSlotUi((u) => ({ ...u, busy: false, feedback }));
      } else {
        await refresh();
        if (type === "continue") api.announceXp(); // a finished task may have earned XP: the header refreshes now
      }
    } catch (e) {
      if (type === "vocabulary_translation" && e instanceof ApiRequestError && e.code === "TRANSLATION_UNAVAILABLE") setSlotUi((u) => ({ ...u, busy: false, translation: "Translation unavailable for this exercise." }));
      else setSlotUi((u) => ({ ...u, busy: false, error: errorText(e) }));
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
      const summary = await api.finishSession(sessionId, mode);
      if (mode === "completed" && summary.status === "completed" && completionSoundSession.current !== sessionId) {
        completionSoundSession.current = sessionId;
        playPracticeSound("complete", soundsEnabled);
      }
      setView({ kind: "summary", summary });
    } catch (e) {
      setSlotUi((u) => ({ ...u, error: errorText(e) }));
    }
  }

  // a finished vocabulary practice ends with a matching game (one of two modes, 50/50) when it had at least 3 different words; any problem skips it
  const [match, setMatch] = useState<{ words: api.MatchWord[]; mode: MatchMode; speech: boolean; rounds: number } | null>(null);
  async function openMatchGame(id: string) {
    try {
      const [{ words }, speech, rounds] = await Promise.all([
        api.fetchMatchWords(id),
        api.fetchVocabularySpeech().then((s) => s.enabled && s.configured).catch(() => false),
        api.fetchSettings().then((s) => s.values.vocabularyMatchRounds ?? 3).catch(() => 3),
      ]);
      if (words.length >= MIN_WORDS) {
        setMatch({ words, mode: Math.random() < 0.5 ? "once" : "rush", speech, rounds });
        return;
      }
    } catch {
      /* the game is optional */
    }
    void finish("completed");
  }

  // every task closed: go straight to the results (nothing is left to choose on that screen)
  const everyTaskClosed = view.kind === "session" && view.session.progress.total > 0 && view.session.progress.closed === view.session.progress.total;
  const autoFinished = useRef<string | null>(null);
  useEffect(() => {
    if (view.kind !== "session" || !everyTaskClosed || autoFinished.current === view.session.sessionId) return;
    autoFinished.current = view.session.sessionId;
    if (category === "vocabulary" && view.session.purpose === "practice") void openMatchGame(view.session.sessionId);
    else void finish("completed");
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
    return <><DailyGoalCheck mode={category} /><SummaryScreen summary={view.summary} onDone={() => (category === "vocabulary" ? onExit?.() : void loadDashboard())} onNavigate={onNavigate} onDailyDone={onDailyDone} onNext={() => void nextSession()} /></>;
  }

  if (view.kind === "dashboard") {
    return <>{otherActive?.category === "vocabulary" && (
      <div className="notice notice-info" role="status" data-testid="other-active">
        <i className="pi pi-bookmark" aria-hidden="true" /> A vocabulary session is still open. Finish it in Vocabulary before starting a grammar lesson.
        {onNavigate && <div className="actions"><button className="btn btn-primary" onClick={() => onNavigate("vocabulary")}><i className="pi pi-arrow-right" aria-hidden="true" /> Continue the vocabulary session</button></div>}
      </div>
    )}{stockBlock && <aside className="notice notice-error" role="alert" data-testid="lesson-stock-low"><strong>More grammar exercises needed</strong><p className="small">{stockBlock}</p>{onNavigate && <div className="actions"><button className="btn btn-primary" onClick={() => onNavigate("studio")}>Open Content Studio</button><button className="link" onClick={() => setStockBlock(null)}>Dismiss</button></div>}</aside>}<DashboardScreen dashboard={view.dashboard} message={view.message} onStart={(id) => void start(id)} onStartCheck={(p) => void startCheck(p)} onReviewRecent={recent ? () => setView({ kind: "summary", summary: recent }) : undefined} />{category !== "vocabulary" && <MyThoughts />}</>;
  }

  if (match) {
    return <MatchGame words={match.words} mode={match.mode} rounds={match.rounds} soundsEnabled={soundsEnabled} speechEnabled={match.speech} onDone={(results) => { const played = match; setMatch(null); if (results && sessionId) void api.saveMatchResults(sessionId, played.mode, results, played.rounds).catch(() => {}).finally(() => void finish("completed")); else void finish("completed"); }} />;
  }

  const session = view.session;
  const allClosed =session.progress.closed === session.progress.total;
  const answered = slotUi.feedback !== null;
  const repeatInfo = slotUi.reveal ? session.slots.find((x) => x.slotId === slotUi.reveal!.slotId)?.repeat : undefined;

  return (
    <section aria-labelledby="practice-h">
      {autoPause.reason && <PauseOverlay auto={autoPause.reason} onResume={autoPause.resume} />}
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
        <div className={`card task ${category === "vocabulary" ? `vocab-task vfmt-${slotUi.reveal.format}` : `fmt-${slotUi.reveal.format}`}`} data-testid="slot" data-format={slotUi.reveal.format} data-slot-id={slotUi.reveal.slotId}>
          <div className={category === "vocabulary" ? "vocab-task-content" : undefined}>
          {slotUi.reveal.inputPreference === "voice" && isShortFormat(slotUi.reveal.format) && !stt.ready && (
            <p className="badge badge-info" data-testid="voice-note">
              <i className="pi pi-ban" aria-hidden="true" /> Voice is not available on this computer right now. Please type your answer.
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
            letters={slotUi.letters}
            correctAnswer={category === "vocabulary" && slotUi.feedback?.verdict === "incorrect" ? (slotUi.feedback.vocabulary?.sentence?.filled ?? null) : null}
            onLetter={(index) => void act("vocabulary_letters", index)}
            onTileHint={async (index) => {
              if (!sessionId || !slotUi.reveal) return null;
              try {
                const shown = (await api.sendEvent(sessionId, slotUi.reveal.slotId, "vocabulary_letters", index)).letters ?? null;
                setSlotUi((u) => ({ ...u, letters: shown })); // kept, so typing mode shows the same opened letters
                return shown;
              } catch (e) {
                setSlotUi((u) => ({ ...u, error: errorText(e) }));
                return null;
              }
            }}
            translation={slotUi.translation}
            onTranslation={() => void act("vocabulary_translation")}
            voice={isShortFormat(slotUi.reveal.format) && voiceUsable ? voice : undefined}
            onSubmit={(a, d) => void submit(a, false, d)}
            onIdk={() => void submit(undefined, true)}
            onSkip={() => void act("skip")}
            onHint={() => void act(category === "vocabulary" ? "vocabulary_letters" : "hint")}
            onShowAnswer={() => void showAnswerAndContinue()}
          />
          {slotUi.checking && <p className="notice notice-info small" role="status" data-testid="ai-checking"><i className="pi pi-spin pi-spinner" aria-hidden="true" /> Checking your answer…</p>}
          {slotUi.feedback && <><DailyGoalCheck mode={category} trigger={slotUi.feedback} /><FeedbackPanel feedback={slotUi.feedback} sessionId={sessionId} skill={category === "vocabulary" ? null : slotUi.reveal.skill} busy={slotUi.busy} onTryAgain={tryAgain} onContinue={goOn} autoAdvance={autoPending} onStay={() => setStay(slotUi.feedback!.slotId)} /></>}
          {slotUi.error && (
            <div className="notice notice-error" role="alert" data-testid="error">
              {slotUi.error}
            </div>
          )}
          </div>
          {category === "vocabulary" && <aside className="vocab-task-image"><WordImage slotId={slotUi.reveal.slotId} hideIfMissing /></aside>}
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

function errorText(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message;
  return e instanceof Error ? e.message : "Something went wrong.";
}
