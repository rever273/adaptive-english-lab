import { useEffect, useState } from "react";
import * as api from "../api";

type Values = { taskCount: number; weakRatio: number; voiceTarget: 0 | 1 | 2; voiceShare?: number; vocabularyTaskCount?: number; vocabularyNewWordsPerSession?: number; difficultyMin?: api.Level; difficultyMax?: api.Level };
type Draft = { taskCount: number; weakRatio: number; voiceShare: number; vocabularyTaskCount: number; vocabularyNewWordsPerSession: number; difficultyMin: api.Level; difficultyMax: api.Level };
const LEVELS: api.Level[] = ["A2", "B1", "B2", "C1"];

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
    <section aria-labelledby="settings-h">
      <h2 id="settings-h">Settings</h2>
      <div className="card settings">
        <label>
          Exercises per session
          <input type="number" min={5} max={30} value={draft.taskCount} onChange={(e) => setDraft({ ...draft, taskCount: clamp(Math.round(Number(e.target.value) || 5), 5, 30) })} data-testid="set-task-count" />
          <span className="muted small">5–30, default {saved.defaults.taskCount}. No daily limit.</span>
        </label>
        <label>
          Vocabulary exercises per session
          <input type="number" min={5} max={10} value={draft.vocabularyTaskCount} onChange={(e) => setDraft({ ...draft, vocabularyTaskCount: clamp(Math.round(Number(e.target.value) || 5), 5, 10) })} />
          <span className="muted small">5–10, default 8. Applies to the next vocabulary session.</span>
        </label>
        <label>
          New words per vocabulary session
          <input type="number" min={1} max={10} value={draft.vocabularyNewWordsPerSession} onChange={(e) => setDraft({ ...draft, vocabularyNewWordsPerSession: clamp(Math.round(Number(e.target.value) || 1), 1, 10) })} data-testid="set-vocab-new-words" />
          <span className="muted small">1–10, default 4. Words you missed or are due for review come first; this is a target for words you have never practised. It is exceeded only if the session cannot otherwise be filled.</span>
        </label>
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
          <span className="muted small">Default A2 to C1 = no restriction. Practice only draws approved exercises of these levels (if there are not enough, the lesson shows the usual shortage message instead of easier ones), and new AI-written exercises are requested at these levels. Applies to the next session or batch.</span>
        </label>
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
        <div className="actions">
          <button className="btn btn-primary" disabled={!changed || busy} onClick={() => void save()} data-testid="save-settings">
            Save
          </button>
          <button className="btn" disabled={busy} onClick={() => setDraft(pick(saved.defaults))}>
            Restore defaults
          </button>
        </div>
        {msg && (
          <p className="notice notice-info small" role="status">
            {msg}
          </p>
        )}
        <p className="muted small">Settings revision {saved.revision}. Changing a setting never changes past answers or statistics.</p>
      </div>
    </section>
  );
}

/** older settings revisions hold a fixed voice count; it is shown as the share of the task count it was */
const pick = (v: Values): Draft => ({ taskCount: v.taskCount, weakRatio: v.weakRatio, voiceShare: v.voiceShare ?? Math.round((v.voiceTarget / v.taskCount) * 20) / 20, vocabularyTaskCount: v.vocabularyTaskCount ?? 8, vocabularyNewWordsPerSession: v.vocabularyNewWordsPerSession ?? 4, difficultyMin: v.difficultyMin ?? "A2", difficultyMax: v.difficultyMax ?? "C1" });
const voiceCount = (d: Draft): number => Math.round(d.voiceShare * d.taskCount);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
