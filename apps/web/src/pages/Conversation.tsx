import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as api from "../api";
import { useVoice } from "../voice";
import { checkDailyGoal } from "../components/DailyGoalNotice";
import { playPracticeSound } from "../practiceSounds";
import { translateConversationMessage } from "../conversationTranslation";

const formatTime = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const topicColour = (value: string) => { let n = 0; for (const c of value) n = (n * 31 + c.charCodeAt(0)) >>> 0; return n % 8; };
function highlighted(text: string, vocabulary: string[]) {
  const words = [...new Set(vocabulary.map(w => w.trim()).filter(w => w.length > 1 && w.length <= 200))].sort((a, b) => b.length - a.length);
  if (!words.length) return text;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${words.map(escape).join("|")})(?![\\p{L}\\p{N}])`, "giu");
  const result = Array.from(text.matchAll(pattern)).reduce<{ nodes: ReactNode[]; at: number }>((r, m) => { const at = m.index; r.nodes.push(text.slice(r.at, at), <span className="conversation-vocab" key={at}>{m[0]}</span>); r.at = at + m[0].length; return r; }, { nodes: [], at: 0 });
  return [...result.nodes, text.slice(result.at)];
}

export function Conversation({ onDailyDone }: { onDailyDone?: () => void }) {
  const [tabId, setTabId] = useState(() => crypto.randomUUID());
  const [home, setHome] = useState<api.ConversationHome | null>(null);
  const [state, setState] = useState<api.ConversationState | null>(null);
  const [topic, setTopic] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const current = useRef<string | null>(null);
  const chatBottom = useRef<HTMLDivElement | null>(null);
  const heard = useRef(new Set<string>());
  const noted = useRef(new Set<string>());
  const player = useRef<HTMLAudioElement | null>(null);
  const audioUrl = useRef<string | null>(null);
  const audioEpoch = useRef(0);
  const [speechError, setSpeechError] = useState(false);
  const [speechChecking, setSpeechChecking] = useState(false);
  const [autoSpeech, setAutoSpeech] = useState(false);
  const [soundsEnabled, setSoundsEnabled] = useState(true);
  const [translation, setTranslation] = useState<{ sessionId: string; messageId: string; status: "loading" | "ready" | "error"; text: string } | null>(null);
  const stopAudio = useCallback(() => { audioEpoch.current++; player.current?.pause(); player.current = null; if (audioUrl.current) URL.revokeObjectURL(audioUrl.current); audioUrl.current = null; setSpeechChecking(false); }, []);
  const speak = useCallback(async (sessionId: string, messageId: string) => {
    stopAudio(); const epoch = audioEpoch.current; setSpeechChecking(true); setSpeechError(false);
    try {
      const blob = await api.conversationSpeech(sessionId, messageId);
      if (epoch !== audioEpoch.current || current.current !== sessionId) return;
      const url = URL.createObjectURL(blob); audioUrl.current = url;
      const audio = new Audio(url); player.current = audio;
      audio.onended = () => { if (audioUrl.current === url) { URL.revokeObjectURL(url); audioUrl.current = null; player.current = null; } };
      await audio.play(); setSpeechError(false);
    } catch { if (epoch === audioEpoch.current) { stopAudio(); setSpeechError(true); } }
    finally { if (epoch === audioEpoch.current) setSpeechChecking(false); }
  }, [stopAudio]);
  const voice = useVoice(state?.session.id ?? null, tabId, !!state, api.conversationSttStart);
  const homeRefresh = useCallback(() => { void api.conversationHome().then(setHome).catch(() => setError("Could not load topics.")); }, []);
  useEffect(homeRefresh, [homeRefresh]);
  useEffect(() => { void api.fetchSettings().then(s => setSoundsEnabled(s.values.practiceSoundsEnabled ?? true)).catch(() => undefined); return stopAudio; }, [stopAudio]);
  useEffect(() => {
    if (!state) return;
    for (const message of state.messages) {
      if (message.role === "assistant" && !heard.current.has(message.id)) {
        if (!autoSpeech) heard.current.add(message.id);
        else if (!["preparing", "recording", "transcribing"].includes(voice.state.phase)) { heard.current.add(message.id); void speak(state.session.id, message.id); }
      }
      if (message.role === "user" && message.analysisStatus === "ready" && !noted.current.has(message.id)) { noted.current.add(message.id); playPracticeSound("correct", soundsEnabled, 0.08); }
    }
  }, [state, speak, soundsEnabled, voice.state.phase, autoSpeech]);
  useEffect(() => { chatBottom.current?.scrollIntoView({ block: "nearest" }); }, [state?.messages.length]);
  useEffect(() => { if (voice.state.phase === "draft") { setInput(voice.state.text); voice.close(); } }, [voice.state]);
  useEffect(() => {
    const id = state?.session.id;
    if (!id) return;
    current.current = id;
    let live = true;
    const poll = window.setInterval(() => { void api.conversationRead(id).then(v => { if (live) setState(v); }).catch(() => undefined); }, 2500);
    const heartbeat = window.setInterval(() => { void api.conversationHeartbeat(id, tabId).then(() => checkDailyGoal("conversation")).catch(() => undefined); }, 5000);
    const hide = () => { if (document.hidden) { current.current = null; stopAudio(); void api.conversationPause(id, tabId).catch(() => undefined); setState(null); homeRefresh(); } };
    document.addEventListener("visibilitychange", hide);
    return () => { live = false; clearInterval(poll); clearInterval(heartbeat); document.removeEventListener("visibilitychange", hide); if (current.current === id) { current.current = null; void api.conversationPause(id, tabId).catch(() => undefined); } };
  }, [state?.session.id, tabId, homeRefresh, stopAudio]);
  const launch = async (resume: boolean) => {
    const nextTabId = crypto.randomUUID();
    setTabId(nextTabId); setError(""); setBusy(true);
    try { const s = resume && home?.latest ? await api.conversationResume(home.latest.id, nextTabId) : await api.conversationStart(topic, nextTabId); heard.current = new Set(resume ? s.messages.filter(m => m.role === "assistant").map(m => m.id) : []); noted.current = new Set(s.messages.filter(m => m.analysisStatus === "ready").map(m => m.id)); setState(s); }
    catch { setError("Could not start the conversation. Please try again."); } finally { setBusy(false); }
  };
  const stop = async () => { if (!state) return; const id = state.session.id; current.current = null; stopAudio(); voice.close(); try { await api.conversationPause(id, tabId); } catch { /* already stopped */ } setState(null); homeRefresh(); checkDailyGoal("conversation"); };
  const send = async () => {
    if (!state || !input.trim() || busy || ["preparing", "recording", "transcribing"].includes(voice.state.phase)) return;
    const text = input.trim(), id = state.session.id; setBusy(true); setError(""); voice.close();
    try { const result = await api.conversationMessage(id, tabId, crypto.randomUUID(), text); if (current.current === id) { setState(result); setInput(""); } }
    catch { if (current.current === id) setError("Your answer was not sent. Please try again."); } finally { setBusy(false); }
  };
  if (!state) return <section className="conversation"><h2><i className="pi pi-comments" /> Conversation</h2><p>Short, relaxed conversations in English.</p>{onDailyDone && <button onClick={onDailyDone}>Continue daily practice <i className="pi pi-arrow-right" /></button>}{error && <p role="alert">{error}</p>}{home?.latest && <div className="conversation-card"><h3>Continue your conversation</h3><p>{home.latest.topic} · {new Date(home.latest.updatedAt).toLocaleString()}</p><button onClick={() => void launch(true)} disabled={busy}>Continue</button></div>}<div className="conversation-card"><h3>Choose a topic</h3><p>Pick one, or try another selection.</p><div className="conversation-topics">{home?.topics.map(t => <button key={t} className={`conversation-topic colour-${topicColour(home.topicGroups[t] ?? t)}${topic === t ? " selected" : ""}`} onClick={() => setTopic(t)}>{t}</button>)}</div><p><button onClick={() => { setTopic(""); homeRefresh(); }}>Other topics</button></p></div><div className="conversation-card conversation-start"><div><h3>Start a new conversation</h3><p>{topic ? `Topic: ${topic}` : "Choose a topic above to begin."}</p></div><button disabled={!topic || busy} onClick={() => void launch(false)}>Start conversation</button></div>{home && <p>{home.statistics.conversations} conversations · {home.statistics.answers} answers · {formatTime(home.statistics.activeMs)} active</p>}</section>;
  const last = [...state.messages].reverse().find(m => m.role === "user");
  const lastAssistant = [...state.messages].reverse().find(m => m.role === "assistant");
  const displayedTranslation = translation?.sessionId === state.session.id && translation.messageId === lastAssistant?.id ? translation : null;
  const translate = () => {
    if (!lastAssistant) return;
    const sessionId = state.session.id, messageId = lastAssistant.id;
    if (displayedTranslation?.status === "ready") { setTranslation(null); return; }
    setTranslation({ sessionId, messageId, status: "loading", text: "" });
    void translateConversationMessage(lastAssistant.text).then(text => setTranslation(current => current?.sessionId === sessionId && current.messageId === messageId ? { ...current, status: "ready", text } : current)).catch((error: unknown) => setTranslation(current => current?.sessionId === sessionId && current.messageId === messageId ? { ...current, status: "error", text: error instanceof api.ApiRequestError ? error.message : "Translation is unavailable. Please try again." } : current));
  };
  const waiting = state.jobs.some(j => j.action === "reply" && ["queued", "waiting_for_gpu", "running"].includes(j.state));
  const failedReply = state.jobs.find(j => j.action === "reply" && j.state === "failed");
  const failedAnalysis = state.jobs.find(j => j.action === "analysis" && j.messageId === last?.id && j.state === "failed");
  let feedback: { ok: boolean; explanation: string; corrected: string } | null = null;
  if (last?.analysisStatus === "ready") {
    try { const parsed = JSON.parse(last.analysis ?? "") as { version?: unknown; ok?: unknown; explanation?: unknown; corrected?: unknown }; if (parsed.version === "conversation-feedback-v2" && typeof parsed.ok === "boolean" && typeof parsed.explanation === "string" && typeof parsed.corrected === "string") feedback = { ok: parsed.ok, explanation: parsed.explanation, corrected: parsed.corrected }; } catch { /* previous feedback was plain text */ }
    feedback ??= { ok: !last.analysis, explanation: last.analysis ?? "", corrected: "" };
  }
  const retry = (jobId: string) => void api.conversationRetry(state.session.id, jobId).then(() => api.conversationRead(state.session.id)).then(setState).catch(() => setError("Could not retry."));
  const remove = () => { if (!window.confirm("Delete the text of this conversation? Your aggregate statistics will remain.")) return; current.current = null; stopAudio(); voice.close(); void api.conversationDelete(state.session.id).then(() => { setState(null); homeRefresh(); }).catch(() => setError("Could not delete the conversation.")); };
  const v = voice.state;
  const voiceBusy = v.phase === "preparing" || v.phase === "recording" || v.phase === "transcribing";
  const canSend = !busy && !voiceBusy && !!input.trim() && state.messages.at(-1)?.role === "assistant";
  return <section className="conversation"><div className="conversation-header"><div><h2>{state.session.topic}</h2><span>Conversation time: {formatTime(state.session.activeMs)}</span></div><div><button onClick={remove}>Delete text</button> <button onClick={() => void stop()}>Stop conversation</button></div></div>
    <div className="conversation-chat" aria-live="polite">{state.messages.map(m => <div key={m.id} className={`conversation-row ${m.role}`}><i className={`pi ${m.role === "user" ? "pi-user" : "pi-android"}`} /><div>{m.role === "assistant" ? highlighted(m.text, state.vocabulary) : m.text}{m.role === "assistant" && <button className="conversation-replay" aria-label="Play assistant message" onClick={() => void speak(state.session.id, m.id)}><i className="pi pi-volume-up" /></button>}</div></div>)}{waiting && <p><i className="pi pi-spin pi-spinner" /> Waiting for a reply…</p>}{failedReply && <p>Could not get a reply. <button onClick={() => retry(failedReply.id)}>Try again</button></p>}<div ref={chatBottom} /></div>
    <div className="conversation-translation" aria-live="polite">
      <div className="conversation-translation-body">{displayedTranslation?.status === "loading" ? <span><i className="pi pi-spin pi-spinner" /> Translating the last message…</span> : displayedTranslation?.status === "error" ? <span>{displayedTranslation.text}</span> : displayedTranslation?.status === "ready" ? <span lang="ru">{displayedTranslation.text}</span> : <span className="muted">Translation of the last assistant message appears here.</span>}</div>
      <div className="conversation-speech-status muted small">{speechChecking ? <span><i className="pi pi-spin pi-spinner" /> Checking voice audio…</span> : speechError ? <span>The voice audio could not be verified. You can read the message or try the speaker button again.</span> : null}</div>
    </div>
    <div className="conversation-compose"><textarea aria-label="Your answer" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (canSend) void send(); } }} placeholder="Write a short answer…" maxLength={2000} /><div><button disabled={busy && !voiceBusy} onClick={() => { stopAudio(); if (v.phase === "preparing" || v.phase === "transcribing") voice.close(); else void (v.phase === "recording" ? voice.stopRecording() : voice.record()); }}><i className={`pi ${voiceBusy ? "pi-stop-circle" : "pi-microphone"}`} /> {v.phase === "recording" ? "Stop recording" : voiceBusy ? "Cancel voice" : "Speak"}</button> <button disabled={!canSend} onClick={() => void send()}>Send</button> <button type="button" disabled={!lastAssistant || displayedTranslation?.status === "loading"} onClick={translate} title="Translate the last assistant message using the configured translation service"><i className="pi pi-language" /> {displayedTranslation?.status === "ready" ? "Hide translation" : "Translate to Russian"}</button> <label className="conversation-auto-speech"><input type="checkbox" checked={autoSpeech} onChange={e => { setAutoSpeech(e.target.checked); if (!e.target.checked) stopAudio(); }} /> Auto-play voice</label></div>
      {v.phase === "preparing" && <p className="voice-status muted"><i className="pi pi-spin pi-spinner" /> Getting speech ready… wait for the red microphone before speaking.</p>}
      {v.phase === "recording" && <div className="voice-live"><span className="rec-dot"><i className="pi pi-microphone" /></span><span className="meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v.level * 100)}>{Array.from({ length: 12 }, (_, i) => <span key={i} className={i < Math.round(v.level * 12) ? "on" : ""} />)}</span><span className="muted">Recording… {Math.floor(v.seconds)} s</span></div>}
      {v.phase === "transcribing" && <p className="voice-status muted"><i className="pi pi-spin pi-spinner" /> Writing down what you said…</p>}{v.phase === "draft" && <p className="muted small">Check and edit the transcript before sending.</p>}{v.phase === "unavailable" && <p>{v.message}</p>}
    </div>
    <div className="conversation-card"><h3>Helpful notes <small> · AI suggestions</small></h3>{!last ? <p>Your answer notes will appear here.</p> : feedback ? <div className={`feedback feedback-${feedback.ok ? "ok" : "again"}`}><p className="feedback-title"><i className={`pi ${feedback.ok ? "pi-check-circle" : "pi-times-circle"}`} /> {feedback.ok ? "Your answer looks good." : "A suggestion"}</p>{!feedback.ok && <><p lang="ru">{feedback.explanation}</p>{feedback.corrected && <p>A possible correction: <strong>{feedback.corrected}</strong></p>}</>}</div> : failedAnalysis ? <p>Notes are unavailable. <button onClick={() => retry(failedAnalysis.id)}>Try again</button></p> : <p><i className="pi pi-spin pi-spinner" /> Checking your answer…</p>}</div>{error && <p role="alert">{error}</p>}</section>;
}
