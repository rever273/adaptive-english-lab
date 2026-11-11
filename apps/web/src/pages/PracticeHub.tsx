import { useEffect, useState } from "react";
import * as api from "../api";
import { groupDigits } from "../stats";

export type PracticeView = "hub" | "grammar" | "cloze";

/** /practice: the choice between the two grammar practices (TASK_032). The classic Practice opens unchanged. */
export function PracticeHub({ onOpen }: { onOpen: (view: "grammar" | "cloze") => void }) {
  const [cloze, setCloze] = useState<api.ClozeOverview | null>(null);
  useEffect(() => {
    let active = true;
    void api.fetchClozeOverview().then((o) => { if (active) setCloze(o); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  const stage1 = cloze?.stages[0];
  const clozeAction = !cloze?.available ? "Start" : cloze.activeSession ? `Continue L${String(cloze.activeSession.levelNo).padStart(2, "0")}` : "Start";
  return (
    <section className="typing-page" aria-label="Grammar practice">
      <h2 id="practice-hub-h"><i className="pi pi-pencil" aria-hidden="true" /> Grammar practice</h2>
      <div className="typing-cards">
        <div className="card typing-mode-card">
          <img className="typing-card-image" src="/practice/grammar.jpg" alt="" loading="lazy" />
          <h3><i className="pi pi-book" aria-hidden="true" /> Grammar Practice</h3>
          <p className="muted small">Lessons with mixed task types, hints and the AI check of your own sentences.</p>
          <button className="btn btn-primary typing-card-action" onClick={() => onOpen("grammar")} data-testid="practice-open-grammar">Open</button>
        </div>
        <div className="card typing-mode-card">
          <img className="typing-card-image" src="/practice/cloze.jpg" alt="" loading="lazy" />
          <h3><i className="pi pi-th-large" aria-hidden="true" /> Grammar Cloze</h3>
          <p className="muted small">Choose the word for the gap. Thousands of sentences; each one is shown once.</p>
          {stage1 && cloze?.available && <p className="typing-level">Stage 1 <span className="muted">({stage1.percent} % · {groupDigits(stage1.processed)} / {groupDigits(stage1.total)})</span></p>}
          {cloze && !cloze.available && <p className="notice notice-warning small" role="status">No sentences are loaded yet. Run <code>npm run cloze:prepare</code> and <code>npm run cloze:import -- --apply</code>.</p>}
          <button className="btn btn-primary typing-card-action" disabled={cloze !== null && !cloze.available} onClick={() => onOpen("cloze")} data-testid="practice-open-cloze">{clozeAction}</button>
        </div>
      </div>
    </section>
  );
}
