import { useEffect, useState } from "react";
import type { FeedbackResponse, SessionSummary } from "@english-lab/contracts";
import * as api from "../../api";
import { unconfirmedLabel } from "../../practiceFlow";
import { watchBlockReview, type ReviewRow } from "../../practiceReview";
import { DetailDiff, VocabWhy } from "./FeedbackDetails";
import { useEnterContinue } from "../../components/hotkeys";

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
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  useEffect(() => {
    setRows(null);
    return watchBlockReview(sessionId, setRows);
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
            {f.correct?.segments && <><p className="small">The mistake: <strong>{f.correct.segments.join(" / ")}</strong></p>{(f.correct.fixes?.length ? f.correct.fixes : f.correct.corrections)?.length ? <p className="small">Right answer: <strong>{(f.correct.fixes?.length ? f.correct.fixes : f.correct.corrections)!.join(" / ")}</strong></p> : null}</>}
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

export function SummaryScreen({ summary: first, onDone, onNavigate, onDailyDone, onNext }: { summary: SessionSummary; onDone: () => void; onNavigate?: (page: "vocabulary" | "analytics") => void; onDailyDone?: () => void; onNext?: () => void }) {
  // T3c: the numbers were fixed at the moment the session ended; while local AI checks of its answers are still running they are re-read, so the counter counts down
  const [summary, setSummary] = useState(first);
  // Enter on the final statistics continues the daily practice, else closes the summary
  // Enter continues THIS training (the next session), never the daily practice or the start screen
  useEnterContinue(onNext ?? null);
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
      <div className="actions">
        {onNext && <button type="button" className="btn btn-primary has-kbd" onClick={onNext} data-testid="next-session"><kbd>Enter</kbd> Next session <i className="pi pi-arrow-right" /></button>}
        {onDailyDone && <button type="button" className="btn btn-primary" onClick={onDailyDone}>Continue Daily Practice <i className="pi pi-arrow-right" /></button>}
        <button className="btn btn-primary" onClick={onDone} data-testid="done">
          <i className={`pi ${vocab ? "pi-bookmark" : "pi-home"}`} aria-hidden="true" /> {vocab ? "Back to Vocabulary" : "Back to start"}
        </button>
        {vocab && onNavigate && (
          <button className="btn" onClick={() => onNavigate("analytics")}>
            <i className="pi pi-chart-line" aria-hidden="true" /> Vocabulary analytics
          </button>
        )}
      </div>
      {(summary.xpEarned ?? 0) > 0 && (
        <p className={`xp-earned xp-earned-${vocab ? "vocabulary" : "grammar"}`} data-testid="xp-earned">
          <i className={`pi ${vocab ? "pi-bookmark-fill" : "pi-pencil"}`} aria-hidden="true" /> +{summary.xpEarned} {vocab ? "Vocabulary" : "Grammar"} XP
          <span className="muted small"> · points for tasks right on the first try</span>
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
        {ai > 0 && <Stat cls="info" icon="pi-sparkles" label="Decided by the local AI (correct ones count at lower weight)" value={ai} id="count-ai-checked" />}
        {(summary.unresolved ?? 0) > 0 && <Stat cls="wait" icon="pi-hourglass" label="Not counted until your agent review (AI said incorrect, or no AI verdict)" value={summary.unresolved ?? 0} id="count-unresolved" />}
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

