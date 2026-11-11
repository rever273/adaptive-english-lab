import { useEffect, useRef, useState } from "react";
import type { Dashboard } from "@english-lab/contracts";
import { MAX_LESSON_PLAYS } from "@english-lab/contracts";
import * as api from "../../api";
import { AgentTasks } from "../../components/AgentTasks";
import { diagnosticFinished } from "../../practiceFlow";

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

export function DashboardScreen({ dashboard, message, onStart, onStartCheck, onReviewRecent }: { dashboard: Dashboard; message: string | null; onStart: (blueprintRevisionId: string) => void; onStartCheck: (purpose: "diagnostic" | "heldout") => void; onReviewRecent?: () => void }) {
  // lessons in course order: the first one that can still build a session is offered; the others stay one click away
  const [chosen, setChosen] = useState<string | null>(null);
  const next = dashboard.blueprints.find((b) => b.unlocked && b.completed < MAX_LESSON_PLAYS) ?? dashboard.blueprints.at(-1);
  const bp = dashboard.blueprints.find((b) => b.blueprintRevisionId === chosen) ?? next;
  const pathRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; left: number; moved: boolean } | null>(null);
  useEffect(() => {
    if (!next) return;
    pathRef.current?.querySelector<HTMLElement>(`[data-lesson-id="${next.blueprintRevisionId}"]`)?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [next?.blueprintRevisionId]);
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
      {dashboard.blueprints.length > 0 && dashboard.blueprints.every((b) => b.completed >= MAX_LESSON_PLAYS) && (
        <div className="notice notice-info" data-testid="all-lessons-finished" role="status">
          <strong>All {dashboard.blueprints.length} lessons are finished ({MAX_LESSON_PLAYS}/{MAX_LESSON_PLAYS}).</strong> Press “Copy task: create new lessons” at the bottom of this page and paste it into your coding agent: it builds the next 5 lessons from your results. You can do the same any time to prepare lessons in advance.
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
      {bp && (
          <div className="lesson-path" ref={pathRef} role="group" aria-label="Lesson path" onMouseDown={(e) => { if (e.button === 0) dragRef.current = { x: e.clientX, left: e.currentTarget.scrollLeft, moved: false }; }} onMouseMove={(e) => { const d = dragRef.current; if (!d || !(e.buttons & 1)) return; if (Math.abs(e.clientX - d.x) > 5) d.moved = true; if (d.moved) { e.currentTarget.scrollLeft = d.left - (e.clientX - d.x); e.preventDefault(); } }} onClickCapture={(e) => { if (dragRef.current?.moved) { e.preventDefault(); e.stopPropagation(); } dragRef.current = null; }} onMouseLeave={() => { dragRef.current = null; }}>
            <div className="lesson-path-track">
              {dashboard.blueprints.map((lesson, i) => (
                <div className="lesson-path-stop" key={lesson.blueprintRevisionId} data-lesson-id={lesson.blueprintRevisionId}>
                  <span className="lesson-path-scenery" aria-hidden="true">{i % 2 === 0 ? "🌳" : "🏠"}</span>
                  <button className={`lesson-path-node${lesson.completed >= MAX_LESSON_PLAYS ? " done" : ""}${bp?.blueprintRevisionId === lesson.blueprintRevisionId ? " selected" : ""}`} disabled={!lesson.unlocked} onClick={() => setChosen(lesson.blueprintRevisionId)} aria-label={`${lesson.title}, ${lesson.completed} of ${MAX_LESSON_PLAYS} plays${lesson.completed >= MAX_LESSON_PLAYS ? ", finished" : lesson.unlocked ? "" : ", locked"}`} aria-pressed={bp?.blueprintRevisionId === lesson.blueprintRevisionId}>
                    <strong>{/l(\d+)$/i.exec(lesson.key)?.[0].toUpperCase() ?? `L${String(i + 1).padStart(2, "0")}`}</strong><small>{lesson.unlocked ? `${lesson.completed >= MAX_LESSON_PLAYS ? "✓ " : ""}${Math.min(lesson.completed, MAX_LESSON_PLAYS)}/${MAX_LESSON_PLAYS}` : "Locked"}</small>
                  </button>
                  <span className="lesson-path-title">{lesson.title.replace(/^L\d+\s+/i, "")}</span>
                </div>
              ))}
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
                <strong>{bp.shortage.deficits.some(d => d.kind === "search_budget") ? `Could not find a valid ${bp.shortage.requestedN}-task session within the search limit.` : `Not enough approved exercises for ${bp.shortage.requestedN} tasks.`}</strong>
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
            <button className="btn btn-primary" disabled={!bp.unlocked || bp.readySessions === 0 || bp.completed >= MAX_LESSON_PLAYS} onClick={() => onStart(bp.blueprintRevisionId)} data-testid="start">
              <i className="pi pi-play" aria-hidden="true" /> {bp.completed >= MAX_LESSON_PLAYS ? `Lesson finished (${MAX_LESSON_PLAYS}/${MAX_LESSON_PLAYS})` : "Start practice"}
            </button>
          </div>
        </div>
      )}
      <ChecksCard dashboard={dashboard} onStartCheck={onStartCheck} />
      <AgentTasks onReviewRecent={onReviewRecent} />
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
