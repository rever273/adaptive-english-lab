import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, fetchGpu, fetchJobs, jobAction, type GpuInfo, type PublicJob } from "../api";

const KIND_LABEL: Record<string, string> = {
  free_text_analysis: "Check a written answer",
  generation: "Write draft exercises",
  triage: "Quick screen of a draft",
  benchmark: "Model benchmark",
};
const STATE_LABEL: Record<string, string> = {
  queued: "Waiting its turn",
  waiting_for_gpu: "Waiting for the graphics card",
  running: "Running",
  paused: "Paused",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};
const ACTIONS: Record<string, Array<"pause" | "resume" | "retry" | "cancel">> = {
  queued: ["pause", "cancel"],
  waiting_for_gpu: ["pause", "cancel"],
  running: ["pause", "cancel"],
  paused: ["resume", "cancel"],
  failed: ["retry"],
};
const GPU_WAIT: Record<string, string> = {
  practice_active: "a practice session is in progress",
  insufficient_vram: "not enough free graphics memory",
  ollama_in_use: "another program is using the language model server",
  profile_unknown: "the model has not been measured yet",
  telemetry_unavailable: "the graphics card cannot be read",
  release_unproven: "the previous model has not been shown to be unloaded",
  no_adapter: "nothing is installed to run this kind of task",
  oom_pressure: "the card ran out of memory",
};

export function AITasks() {
  const [jobs, setJobs] = useState<PublicJob[] | null>(null);
  const [gpu, setGpu] = useState<GpuInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [j, g] = await Promise.all([fetchJobs(), fetchGpu()]);
      setJobs(j.jobs);
      setGpu(g);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Cannot load the task list.");
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (id: string, action: "pause" | "resume" | "retry" | "cancel") => {
    setBusy(id);
    try {
      await jobAction(id, action);
      await load();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "That action is not possible now.");
    } finally {
      setBusy(null);
    }
  };

  const counts = (jobs ?? []).reduce<Record<string, number>>((a, j) => ((a[j.state] = (a[j.state] ?? 0) + 1), a), {});
  return (
    <>
      <section className="card" aria-labelledby="ai-h">
        <h2 id="ai-h">AI tasks</h2>
        <p className="lede">Background work done by the small local models. Practice always comes first: a running task is stopped while you practise and starts again afterwards. Nothing here changes your progress.</p>
        {error && <p className="notice notice-error" role="alert">{error}</p>}
        {gpu && (
          <dl data-testid="gpu">
            <dt>Graphics card</dt>
            <dd>
              {!gpu.available
                ? "Task runner is not running."
                : gpu.telemetry === "unavailable"
                  ? "Memory cannot be read."
                  : `${Math.round(gpu.telemetry.usedMib / 1024 * 10) / 10} of ${Math.round(gpu.telemetry.totalMib / 1024 * 10) / 10} GB in use`}
              {gpu.available && gpu.practiceActive && <span className="badge badge-info"> practice in progress</span>}
            </dd>
            {gpu.available && (
              <>
                <dt>Model in memory</dt>
                <dd>{gpu.residentModels.length > 0 ? gpu.residentModels.join(", ") : "none"}</dd>
                <dt>Right now</dt>
                <dd>{gpu.activeJob ? `${KIND_LABEL[gpu.activeJob.kind] ?? gpu.activeJob.kind} (${Math.round(gpu.activeJob.runningForMs / 1000)} s)` : "idle"}</dd>
                {Object.keys(gpu.waitingByReason).length > 0 && (
                  <>
                    <dt>Waiting because</dt>
                    <dd>{Object.entries(gpu.waitingByReason).map(([r, n]) => `${n} × ${GPU_WAIT[r] ?? r.replace(/_/g, " ")}`).join("; ")}</dd>
                  </>
                )}
              </>
            )}
          </dl>
        )}
      </section>
      <section className="card" aria-labelledby="jobs-h">
        <h2 id="jobs-h">Tasks</h2>
        {jobs === null ? (
          <p role="status">Loading…</p>
        ) : jobs.length === 0 ? (
          <p className="muted">No tasks yet. They appear here when you write an answer that needs checking or ask Content Studio for drafts.</p>
        ) : (
          <>
            <p className="muted small" data-testid="job-counts">{Object.entries(counts).map(([s, n]) => `${n} ${(STATE_LABEL[s] ?? s).toLowerCase()}`).join(" · ")}</p>
            <div className="table-wrap">
              <table className="summary-table wide" data-testid="jobs">
                <thead>
                  <tr><th>Task</th><th>State</th><th>Progress</th><th>Started</th><th /></tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={j.id} data-state={j.state}>
                      <td>{KIND_LABEL[j.kind] ?? j.kind}</td>
                      <td>
                        <span className={`badge ${j.state === "failed" ? "badge-warn" : j.state === "completed" ? "badge-ok" : "badge-info"}`}>{STATE_LABEL[j.state] ?? j.state}</span>
                        {j.errorCode && <span className="muted small"> {j.errorCode.replace(/_/g, " ")}</span>}
                        {j.retryCount > 0 && <span className="muted small"> · retry {j.retryCount}</span>}
                      </td>
                      <td>{j.progress ? `${j.progress.done} of ${j.progress.total}` : "—"}</td>
                      <td>{j.startedAt ? new Date(j.startedAt).toLocaleTimeString() : "—"}</td>
                      <td className="row-actions">
                        {(ACTIONS[j.state] ?? []).map((a) => (
                          <button key={a} className="btn btn-small" disabled={busy === j.id} onClick={() => void act(j.id, a)}>
                            {a[0]!.toUpperCase() + a.slice(1)}
                          </button>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </>
  );
}
