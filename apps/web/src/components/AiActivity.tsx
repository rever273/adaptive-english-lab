import { useEffect, useRef, useState } from "react";
import { fetchAiActivity, type AiActivity as Activity, type AiWave } from "../api";
import { GPU_WAIT, KIND_LABEL } from "../pages/AITasks";

const minutes = (ms: number): string => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);

function WaveRow({ w, a }: { w: AiWave; a: Activity }) {
  const finished = w.done + w.failed;
  const pct = w.total > 0 ? Math.round((finished / w.total) * 100) : 0;
  const running = a.active?.kind === w.kind;
  const state = running
    ? `running${a.models.length ? ` · ${a.models.join(", ")}` : ""}`
    : a.practiceActive
      ? "paused while you practise"
      : w.waitingReason
        ? `waiting: ${GPU_WAIT[w.waitingReason] ?? w.waitingReason.replace(/_/g, " ")}`
        : w.paused === w.open
          ? "paused"
          : "in the queue";
  return (
    <li className="ai-wave">
      <div className="ai-wave-head">
        <strong>{KIND_LABEL[w.kind] ?? w.kind}</strong>
        <span className="ai-count">{finished} / {w.total}</span>
      </div>
      <div className="ai-bar" role="progressbar" aria-valuemin={0} aria-valuemax={w.total} aria-valuenow={finished} aria-label={`${KIND_LABEL[w.kind] ?? w.kind}: ${finished} of ${w.total}`}>
        <span className={running ? "ai-bar-live" : ""} style={{ width: `${pct}%` }} />
      </div>
      <div className="ai-wave-meta small">
        <span className={running ? "ai-live" : "muted"}>{running && <i className="pi pi-spin pi-spinner" aria-hidden="true" />} {state}</span>
        {w.msPerItem !== null && <span className="muted">~{minutes(w.msPerItem)} each · ≈ {minutes(w.msPerItem * w.open)} left</span>}
        {w.failed > 0 && <span className="ai-failed">{w.failed} failed</span>}
      </div>
    </li>
  );
}

/**
 * A small pinned panel that opens by itself when any local model starts working and shows only the essentials: which task, how many of
 * how many, the measured time per item and what it is waiting for. The full list stays on the AI tasks page.
 */
export function AiActivity({ onOpenTasks }: { onOpenTasks: () => void }) {
  const [a, setA] = useState<Activity | null>(null);
  const [open, setOpen] = useState(true);
  const wasBusy = useRef(false);

  useEffect(() => {
    let off = false;
    const load = () =>
      fetchAiActivity()
        .then((r) => {
          if (off) return;
          setA(r);
          const busy = r.waves.length > 0;
          if (busy && !wasBusy.current) setOpen(true); // a new wave of work: unfold
          wasBusy.current = busy;
        })
        .catch(() => undefined);
    void load();
    const t = window.setInterval(load, 2500);
    return () => {
      off = true;
      window.clearInterval(t);
    };
  }, []);

  if (!a || a.waves.length === 0) return null;
  const finished = a.waves.reduce((n, w) => n + w.done + w.failed, 0);
  const total = a.waves.reduce((n, w) => n + w.total, 0);
  const live = a.active !== null;
  if (!open) {
    return (
      <button type="button" className={`ai-pill${live ? " ai-pill-live" : ""}`} onClick={() => setOpen(true)} aria-label={`Local AI: ${finished} of ${total} done. Show details`} data-testid="ai-pill">
        <i className={`pi ${live ? "pi-spin pi-cog" : "pi-microchip"}`} aria-hidden="true" /> AI {finished}/{total}
      </button>
    );
  }
  return (
    <aside className="ai-panel" aria-label="Local AI activity" data-testid="ai-panel">
      <header className="ai-panel-head">
        <span><i className={`pi ${live ? "pi-spin pi-cog" : "pi-microchip"}`} aria-hidden="true" /> Local AI</span>
        {a.telemetry && <span className="muted small" title="Graphics memory in use">{Math.round((a.telemetry.usedMib / a.telemetry.totalMib) * 100)}% VRAM</span>}
        <span className="ai-panel-tools">
          <button type="button" className="icon-btn" onClick={onOpenTasks} title="Open AI tasks" aria-label="Open AI tasks"><i className="pi pi-external-link" aria-hidden="true" /></button>
          <button type="button" className="icon-btn" onClick={() => setOpen(false)} title="Hide" aria-label="Hide the AI panel"><i className="pi pi-minus" aria-hidden="true" /></button>
        </span>
      </header>
      <ul className="ai-waves">{a.waves.slice(0, 3).map((w) => <WaveRow key={w.kind} w={w} a={a} />)}</ul>
    </aside>
  );
}
