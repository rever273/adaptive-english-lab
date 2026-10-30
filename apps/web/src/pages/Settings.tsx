import { useEffect, useState } from "react";
import * as api from "../api";

type Values = { taskCount: number; weakRatio: number; voiceTarget: 0 | 1 | 2 };

/** docs/04 §7: only the settings the allocator reads today. A change is a new settings revision and applies to the next session. */
export function Settings() {
  const [saved, setSaved] = useState<{ revision: number; values: Values; defaults: Values } | null>(null);
  const [draft, setDraft] = useState<Values | null>(null);
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
          Weak skills share: {Math.round(draft.weakRatio * 100)}%
          <input type="range" min={0} max={100} step={5} value={Math.round(draft.weakRatio * 100)} onChange={(e) => setDraft({ ...draft, weakRatio: Number(e.target.value) / 100 })} data-testid="set-weak-ratio" />
          <span className="muted small">The rest explores new skills. Default {Math.round(saved.defaults.weakRatio * 100)}%.</span>
        </label>
        <label>
          Voice tasks per session (optional)
          <select value={draft.voiceTarget} onChange={(e) => setDraft({ ...draft, voiceTarget: Number(e.target.value) as 0 | 1 | 2 })} data-testid="set-voice">
            <option value={0}>0</option>
            <option value={1}>1</option>
            <option value={2}>2</option>
          </select>
          <span className="muted small">You can always type or skip instead. Default {saved.defaults.voiceTarget}.</span>
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

const pick = (v: Values): Values => ({ taskCount: v.taskCount, weakRatio: v.weakRatio, voiceTarget: v.voiceTarget });
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
