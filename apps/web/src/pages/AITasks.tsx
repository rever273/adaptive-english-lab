import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, fetchGpu, fetchJobs, jobAction, type GpuInfo, type PublicJob } from "../api";

export const KIND_LABEL: Record<string, string> = {
  free_text_analysis: "Check a written answer",
  generation: "Write draft exercises",
  triage: "Quick screen of a draft",
  benchmark: "Model benchmark",
  vocabulary_enrichment: "Translate a saved word",
  tutor: "Tutor answer",
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
export const GPU_WAIT: Record<string, string> = {
  practice_active: "a practice session is in progress",
  insufficient_vram: "not enough free graphics memory",
  ollama_in_use: "another program is using the language model server",
  profile_unknown: "the model has not been measured yet",
  telemetry_unavailable: "the graphics card cannot be read",
  release_unproven: "the previous model has not been shown to be unloaded",
  no_adapter: "nothing is installed to run this kind of task",
  oom_pressure: "the card ran out of memory",
};
const VALIDATION_REASON: Record<string, string> = {
  EXAMPLE_WITHOUT_WORD: "the example did not use the saved word",
  TRANSLATION: "the translation was missing or not in Russian",
  POS: "the part of speech was not recognised",
  EXAMPLE: "the example was invalid",
  COLLOCATIONS: "the collocations were invalid",
  WRONG_ENTRY: "the response referred to a different word",
  SCHEMA: "the response was incomplete or had an invalid format",
  NOT_JSON: "the response was not valid JSON",
  TOO_LARGE: "the response was too long",
};

export function AITasks() {
  const [jobs, setJobs] = useState<PublicJob[] | null>(null);
  const [gpu, setGpu] = useState<GpuInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [, tick] = useState(0);
  // the task list: only the newest rows are loaded; scrolling to the end loads more (30 at a time), and the list can be folded away
  const PAGE = 30;
  const [visible, setVisible] = useState(PAGE);
  const visibleRef = useRef(PAGE);
  const [meta, setMeta] = useState<{ counts: Record<string, number>; total: number }>({ counts: {}, total: 0 });
  const [listOpen, setListOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem("aiTasks.listOpen") !== "0";
    } catch {
      return true;
    }
  });
  const toggleList = () =>
    setListOpen((o) => {
      try {
        localStorage.setItem("aiTasks.listOpen", o ? "0" : "1");
      } catch {
        /* a convenience only */
      }
      return !o;
    });
  const more = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const [j, g] = await Promise.all([fetchJobs(visibleRef.current), fetchGpu()]);
      setJobs(j.jobs);
      setMeta({ counts: j.counts, total: j.total });
      setGpu(g);
      setUpdatedAt(Date.now());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Cannot load the task list.");
    }
  }, []);
  // reaching the end of the list asks for the next page
  const hasMore = (jobs?.length ?? 0) < meta.total && visible < 500;
  useEffect(() => {
    const el = more.current;
    if (!listOpen || !el || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        visibleRef.current = Math.min(500, visibleRef.current + PAGE);
        setVisible(visibleRef.current);
        void load();
      },
      { root: el.parentElement, rootMargin: "80px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [listOpen, hasMore, jobs?.length, load]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 2000);
    const clock = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      clearInterval(t);
      clearInterval(clock);
    };
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

  const counts = meta.counts;
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
                  : (
                    <>
                      <span className="bar gpu-bar" aria-hidden="true">
                        <span style={{ width: `${Math.min(100, (gpu.telemetry.usedMib / gpu.telemetry.totalMib) * 100)}%` }} />
                      </span>{" "}
                      {gpu.telemetry.usedMib.toLocaleString("en-AU")} of {gpu.telemetry.totalMib.toLocaleString("en-AU")} MiB in use ({Math.round((gpu.telemetry.usedMib / gpu.telemetry.totalMib) * 100)}%)
                    </>
                  )}
              {updatedAt && <span className="muted small"> · <i className="pi pi-sync" aria-hidden="true" /> updated {Math.max(0, Math.round((Date.now() - updatedAt) / 1000))} s ago</span>}
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
        <h2 id="jobs-h" className="fold-head">
          <button type="button" className="fold-btn" onClick={toggleList} aria-expanded={listOpen} aria-controls="jobs-list" data-testid="fold-jobs">
            <i className={`pi ${listOpen ? "pi-chevron-down" : "pi-chevron-right"}`} aria-hidden="true" /> Tasks <span className="muted small">{meta.total > 0 ? `· ${meta.total}` : ""}</span>
          </button>
        </h2>
        {!listOpen ? (
          <p className="muted small" data-testid="job-counts">{Object.entries(counts).map(([st, n]) => `${n} ${(STATE_LABEL[st] ?? st).toLowerCase()}`).join(" · ") || "No tasks yet."} — the list is folded.</p>
        ) : jobs === null ? (
          <p role="status">Loading…</p>
        ) : jobs.length === 0 ? (
          <p className="muted">No tasks yet. They appear here when you write an answer that needs checking or ask Content Studio for drafts.</p>
        ) : (
          <>
            <p className="muted small" data-testid="job-counts">{Object.entries(counts).map(([s, n]) => `${n} ${(STATE_LABEL[s] ?? s).toLowerCase()}`).join(" · ")}</p>
            <div className="table-wrap jobs-scroll" id="jobs-list">
              <table className="summary-table wide" data-testid="jobs">
                <thead>
                  <tr><th>Task</th><th>State</th><th>Progress</th><th>Started</th><th /></tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={j.id} data-state={j.state}>
                      <td>{KIND_LABEL[j.kind] ?? j.kind}{j.word && <>: <strong>{j.word}</strong></>}</td>
                      <td>
                        <span className={`badge ${j.state === "failed" ? "badge-warn" : j.state === "completed" ? "badge-ok" : "badge-info"}`}>{STATE_LABEL[j.state] ?? j.state}</span>
                        {j.errorCode && <span className="muted small"> {j.errorCode.replace(/_/g, " ")}</span>}
                        {j.errorCode === "failed_validation" && j.diagnosticCodes && j.diagnosticCodes.length > 0 && <div className="muted small">{j.diagnosticCodes.map(c => VALIDATION_REASON[c] ?? "the response did not pass a required check").join("; ")}</div>}
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
              {hasMore ? (
                <div ref={more} className="jobs-more muted small" role="status"><i className="pi pi-spin pi-spinner" aria-hidden="true" /> Loading more…</div>
              ) : (
                meta.total > (jobs?.length ?? 0) && <div className="jobs-more muted small">Showing the newest {jobs?.length} of {meta.total}.</div>
              )}
            </div>
          </>
        )}
      </section>
    </>
  );
}
