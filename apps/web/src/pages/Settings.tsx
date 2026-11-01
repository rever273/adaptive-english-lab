import { useEffect, useState } from "react";
import type { AiModelStatus } from "@english-lab/contracts";
import * as api from "../api";
import { modelErrorText } from "../components/AiModelNotice";

type Values = { preloadModelOnStart?: boolean; taskCount: number; weakRatio: number; voiceTarget: 0 | 1 | 2; voiceShare?: number; vocabularyTaskCount?: number; vocabularyNewWordsPerSession?: number; reviewNoticeThreshold?: number; difficultyMin?: api.Level; difficultyMax?: api.Level };
type Draft = { taskCount: number; weakRatio: number; voiceShare: number; vocabularyTaskCount: number; vocabularyNewWordsPerSession: number; reviewNoticeThreshold: number; difficultyMin: api.Level; difficultyMax: api.Level };
const LEVELS: api.Level[] = ["A2", "B1", "B2", "C1", "C2"];

/** docs/04 §7: only the settings the allocator reads today. A change is a new settings revision and applies to the next session. */
export function Settings() {
  const [saved, setSaved] = useState<{ revision: number; values: Values; defaults: Values } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .fetchSettings()
      .then((s) => {
        setSaved(s);
        setDraft(pick(s.values));
      })
      .catch((e) => setMsg(e instanceof Error ? e.message : String(e)));
  }, []);

  if (!draft || !saved) return <section className="card">{msg ?? "Loading settings…"}</section>;
  const changed = JSON.stringify(draft) !== JSON.stringify(pick(saved.values));

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const s = await api.saveSettings(draft);
      setSaved(s);
      setDraft(pick(s.values));
      setMsg("Saved. The next session you start uses these settings; the current one keeps its own.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="settings-h" className="settings-page">
      <h2 id="settings-h">Settings</h2>
      <div className="settings-grid">
        <div className="card settings-card">
          <h3>Practice</h3>
          <div className="settings-fields">
            <label>
              Exercises per session
              <input type="number" min={5} max={30} value={draft.taskCount} onChange={(e) => setDraft({ ...draft, taskCount: clamp(Math.round(Number(e.target.value) || 5), 5, 30) })} data-testid="set-task-count" />
              <span className="muted small">5–30, default {saved.defaults.taskCount}. No daily limit.</span>
            </label>
          </div>
          <label>
            Weak skills share: {Math.round(draft.weakRatio * 100)}%
            <input type="range" min={0} max={100} step={5} value={Math.round(draft.weakRatio * 100)} onChange={(e) => setDraft({ ...draft, weakRatio: Number(e.target.value) / 100 })} data-testid="set-weak-ratio" />
            <span className="muted small">The rest explores new skills. Default {Math.round(saved.defaults.weakRatio * 100)}%.</span>
          </label>
          <label>
            Voice tasks: {Math.round(draft.voiceShare * 100)}% ≈ {voiceCount(draft)} of {draft.taskCount} tasks
            <input type="range" min={0} max={100} step={5} value={Math.round(draft.voiceShare * 100)} onChange={(e) => setDraft({ ...draft, voiceShare: Number(e.target.value) / 100 })} data-testid="set-voice" aria-valuetext={`${Math.round(draft.voiceShare * 100)}%, about ${voiceCount(draft)} tasks`} />
            <span className="muted small">
              Only tasks where you write a sentence can be spoken, so a session may have fewer. You can always type or skip instead. Default {Math.round(pick(saved.defaults).voiceShare * 100)}% (≈ {voiceCount(pick(saved.defaults))} of {saved.defaults.taskCount}).
            </span>
          </label>
        </div>

        <div className="card settings-card">
          <h3>Vocabulary</h3>
          <div className="settings-fields">
            <label>
              Exercises per session
              <input type="number" min={5} max={10} value={draft.vocabularyTaskCount} onChange={(e) => setDraft({ ...draft, vocabularyTaskCount: clamp(Math.round(Number(e.target.value) || 5), 5, 10) })} />
              <span className="muted small">5–10, default 8. Applies to the next vocabulary session.</span>
            </label>
            <label>
              New words per session
              <input type="number" min={1} max={10} value={draft.vocabularyNewWordsPerSession} onChange={(e) => setDraft({ ...draft, vocabularyNewWordsPerSession: clamp(Math.round(Number(e.target.value) || 1), 1, 10) })} data-testid="set-vocab-new-words" />
              <span className="muted small">1–10, default 4. Missed and due words come first; this is a target for words you have never practised, exceeded only if the session cannot otherwise be filled.</span>
            </label>
          </div>
        </div>

        <div className="card settings-card">
          <h3>Difficulty and review</h3>
          <label>
            Sentence difficulty (CEFR)
            <span className="level-range">
              <select value={draft.difficultyMin} aria-label="Lowest level" data-testid="set-level-min" onChange={(e) => { const min = e.target.value as api.Level; setDraft({ ...draft, difficultyMin: min, difficultyMax: LEVELS.indexOf(draft.difficultyMax) < LEVELS.indexOf(min) ? min : draft.difficultyMax }); }}>
                {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
              {" to "}
              <select value={draft.difficultyMax} aria-label="Highest level" data-testid="set-level-max" onChange={(e) => { const max = e.target.value as api.Level; setDraft({ ...draft, difficultyMax: max, difficultyMin: LEVELS.indexOf(draft.difficultyMin) > LEVELS.indexOf(max) ? max : draft.difficultyMin }); }}>
                {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </span>
            <span className="muted small">Default B1 to C1. Practice only draws approved exercises of these levels (if there are not enough, the lesson shows the usual shortage message instead of easier ones), and new AI-written exercises are requested at these levels. Applies to the next session or batch.</span>
          </label>
          <label>
            Answers to collect before the review notice
            <input type="number" min={1} max={50} value={draft.reviewNoticeThreshold} onChange={(e) => setDraft({ ...draft, reviewNoticeThreshold: clamp(Math.round(Number(e.target.value) || 1), 1, 50) })} data-testid="set-review-threshold" />
            <span className="muted small">1–50, default 5. Answers the local AI could not check wait in a queue; once this many have collected, Practice shows one notice with a task for your coding agent.</span>
          </label>
        </div>
      </div>

      <div className="card settings-bar">
        <div className="actions">
          <button className="btn btn-primary" disabled={!changed || busy} onClick={() => void save()} data-testid="save-settings">
            Save
          </button>
          <button className="btn" disabled={busy} onClick={() => setDraft(pick(saved.defaults))}>
            Restore defaults
          </button>
          <span className="muted small">Settings revision {saved.revision}. Changing a setting never changes past answers or statistics. The cards below apply at once.</span>
        </div>
        {msg && (
          <p className="notice notice-info small" role="status">
            {msg}
          </p>
        )}
      </div>

      <div className="settings-grid">
        <VocabularySpeechSettings />
        <ModelSection preload={saved.values.preloadModelOnStart ?? true} />
        <StatusSection />
      </div>
    </section>
  );
}

/** Where the app talks to outside services: ElevenLabs credits (pronunciation) and Groq (speech recognition). */
function StatusSection() {
  const [credits, setCredits] = useState<api.VocabularySpeechCredits | null>(null);
  const [groq, setGroq] = useState<api.GroqStatus | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [requests, setRequests] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const load = () => {
    setChecking(true);
    void Promise.all([
      api.fetchVocabularySpeech().then((s) => { setConfigured(s.configured); setRequests(s.requests); return s.configured ? api.fetchVocabularySpeechCredits().then(setCredits) : setCredits(null); }).catch(() => setCredits({ available: false, reason: "Unable to load the credits.", appCharacters30d: 0 })),
      api.fetchGroqStatus().then(setGroq).catch(() => setGroq({ configured: false, reachable: false, reason: "Unable to load the Groq status.", limits: null })),
    ]).finally(() => setChecking(false));
  };
  useEffect(load, []);
  return <div className="card settings-card" data-testid="service-status">
    <h3>Voice info</h3>
    <h4>ElevenLabs (pronunciation)</h4>
    {configured === false && <p className="muted small">Not configured: add an ElevenLabs API key and voice ID.</p>}
    {credits?.available && credits.limit !== undefined && credits.used !== undefined
      ? <>
        <p className="small" data-testid="eleven-credits">Credits: <strong>{credits.used.toLocaleString()} / {credits.limit.toLocaleString()}</strong> characters used ({credits.remaining?.toLocaleString()} left){credits.resetsAt ? `, resets ${new Date(credits.resetsAt).toLocaleDateString()}` : ""}{credits.tier ? ` · plan: ${credits.tier}` : ""}.</p>
        <progress max={credits.limit} value={credits.used} aria-label="ElevenLabs credits used" />
      </>
      : credits && <p className="muted small">Credits unavailable: {credits.reason}</p>}
    {credits && <p className="muted small">Sent by this app in the last 30 days: {credits.appCharacters30d.toLocaleString()} characters.</p>}
    {requests !== null && <p className="muted small">Requests in the last 24 hours: {requests}. Cached recordings need no request.</p>}
    <h4>Groq (speech recognition)</h4>
    {groq && (!groq.configured
      ? <p className="muted small" data-testid="groq-status">{groq.reason}</p>
      : <p className="small" data-testid="groq-status">{groq.reachable ? "Key accepted, Groq is reachable." : `Not available: ${groq.reason}`}</p>)}
    {groq?.configured && (groq.limits
      ? <>
        <p className="muted small">Limits reported with the latest transcription ({new Date(groq.limits.capturedAt).toLocaleString()}, HTTP {groq.limits.status}):</p>
        <ul className="muted small">{Object.entries(groq.limits.headers).map(([k, v]) => <li key={k}>{k.replace(/^x-ratelimit-/, "").replace(/-/g, " ")}: {v}</li>)}</ul>
      </>
      : <p className="muted small">Groq reports no credit balance. Remaining limits appear here after the first voice answer since the app started.</p>)}
    <button type="button" className="btn" disabled={checking} onClick={load}>{checking ? "Checking…" : "Refresh status"}</button>
  </div>;
}

function VocabularySpeechSettings() {
  const [status, setStatus] = useState<api.VocabularySpeechStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api.fetchVocabularySpeech().then(setStatus).catch(() => setError("Unable to load pronunciation settings.")); }, []);
  const toggle = async (enabled: boolean) => {
    try { setStatus(await api.setVocabularySpeech(enabled)); setError(null); }
    catch { setError("Unable to save pronunciation settings."); }
  };
  return <div className="card settings-card">
    <h3>Vocabulary pronunciation</h3>
    {status && <>
      <label className="check"><input type="checkbox" checked={status.enabled} onChange={(e) => void toggle(e.target.checked)} /> Automatically pronounce revealed answers in Vocabulary Practice</label>
            {!status.configured && <p className="muted small">Add an ElevenLabs API key and voice ID to enable pronunciation.</p>}
      {status.blockedUntil && <p className="muted small">ElevenLabs rate limit: paused until {new Date(status.blockedUntil).toLocaleString()}.</p>}
    </>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

/** older settings revisions hold a fixed voice count; it is shown as the share of the task count it was */
const pick = (v: Values): Draft => ({ taskCount: v.taskCount, weakRatio: v.weakRatio, voiceShare: v.voiceShare ?? Math.round((v.voiceTarget / v.taskCount) * 20) / 20, vocabularyTaskCount: v.vocabularyTaskCount ?? 8, vocabularyNewWordsPerSession: v.vocabularyNewWordsPerSession ?? 4, reviewNoticeThreshold: v.reviewNoticeThreshold ?? 5, difficultyMin: v.difficultyMin ?? (v.difficultyMax ? "A2" : "B1"), difficultyMax: v.difficultyMax ?? "C1" });
const voiceCount = (d: Draft): number => Math.round(d.voiceShare * d.taskCount);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const BUSY_TEXT: Record<string, string> = {
  job_running: "an AI task is running",
  practice_active: "speech recognition is using the graphics card",
  loading: "the model is loading",
  unloading: "the model is unloading",
};

/** D67: the one local model. One button (Load / Unload, no confirmation); the toggle is saved at once and does not need the Save button. */
function ModelSection({ preload }: { preload: boolean }) {
  const [st, setSt] = useState<AiModelStatus | null>(null);
  const [on, setOn] = useState(preload);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let off = false;
    let timer: number | undefined;
    const tick = async () => {
      const next = await api.fetchAiModel().catch(() => null);
      if (off) return;
      if (next) setSt(next);
      timer = window.setTimeout(() => void tick(), next && (next.state === "loading" || next.state === "unloading") ? 1500 : 5000);
    };
    void tick();
    return () => {
      off = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  const act = async (f: () => Promise<AiModelStatus>) => {
    setPending(true);
    setErr(null);
    try {
      setSt(await f());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };
  const toggle = async (v: boolean) => {
    setOn(v);
    try {
      await api.savePreloadModel(v);
    } catch (e) {
      setOn(!v);
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const loaded = st?.state === "ready";
  const transition = st?.state === "loading" || st?.state === "unloading";
  // unloading needs the model free of a running task; loading needs the card free of local speech recognition
  const reason = st === null ? "checking the model" : transition ? BUSY_TEXT[st.state]! : loaded ? (st.busy === "job_running" ? BUSY_TEXT.job_running! : null) : st.busy === "practice_active" ? BUSY_TEXT.practice_active! : null;
  const line =
    st === null ? "Checking the AI model..." :
    st.state === "ready" ? `${st.model} is loaded${st.vramBytes ? ` (${(st.vramBytes / 1024 ** 3).toFixed(1)} GB of graphics memory)` : ""}.` :
    st.state === "loading" ? `Loading ${st.model} - the first load takes about 40 seconds.` :
    st.state === "unloading" ? `Unloading ${st.model}...` :
    st.state === "error" ? `${st.model}: problem - ${modelErrorText(st.error)}.` :
    `${st.model} is not loaded.`;
  return (
    <div className="card settings-card" data-testid="model-section">
      <h3>AI model</h3>
      <p role="status" data-testid="model-status">{line}</p>
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => void toggle(e.target.checked)} data-testid="set-preload-model" /> Load the model when the app starts and when I start practising
      </label>
      <span className="muted small">The first load takes about 40 seconds; a loaded model keeps answer checks and word look-ups instant. It is unloaded when the app stops.</span>
      <div className="actions">
        <button className="btn" disabled={pending || reason !== null} onClick={() => void act(loaded ? api.unloadAiModel : api.loadAiModel)} data-testid="model-toggle">
          {loaded ? "Unload model" : "Load model now"}
        </button>
        {reason && <span className="muted small">Unavailable: {reason}.</span>}
      </div>
      {err && <p className="notice notice-warn small" role="status">{err}</p>}
    </div>
  );
}
