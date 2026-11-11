import type { FeedbackResponse } from "@english-lab/contracts";

const FAMILY_NAME: Record<string, string> = { recognition: "word in context", guided_recall: "recall", collocation: "collocation" };

/** vocabulary: the reviewed reason for every option - why the right one fits here and why each other one does not (details on demand) */
export function VocabWhy({ v, compact = false }: { v: NonNullable<FeedbackResponse["vocabulary"]>; compact?: boolean }) {
  const chosenWrong = v.options.find((o) => o.chosen && !o.correct);
  return (
    <div className="vocab-why" data-testid="vocab-why">
      <p className="small muted">
        <i className="pi pi-bookmark" aria-hidden="true" /> <strong>{v.lemma}</strong> · {v.partOfSpeech} · {FAMILY_NAME[v.family] ?? v.family}
      </p>
      {chosenWrong && !compact && <p lang="ru" className="ru small"><strong>{chosenWrong.text}</strong>: {chosenWrong.rationaleRu}</p>}
      {v.options.length > 0 && (
        <details>
          <summary className="small">Why? All options</summary>
          <ul className="why-list">
            {v.options.map((o) => (
              <li key={o.text} className={o.correct ? "why-ok" : "why-no"}>
                <i className={`pi ${o.correct ? "pi-check" : "pi-times"}`} aria-hidden="true" /> <strong>{o.text}</strong>{o.chosen && <span className="muted small"> (your choice)</span>} — <span lang="ru">{o.rationaleRu}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** D64: the learner's sentence with the name/number that differs from the task marked in red */
export function DetailDiff({ d }: { d: NonNullable<FeedbackResponse["detail"]> }) {
  return (
    <div className="detail-diff" data-testid="detail-diff">
      <p>
        {d.tokens.map((t, i) => (
          <span key={i}>
            {i > 0 && " "}
            {t.differs ? <mark className="diff-bad" title="Different from the task">{t.text}</mark> : t.text}
          </span>
        ))}
      </p>
      <p className="small">
        The task asked for <strong className="diff-good">{d.expected.join(", ")}</strong>. Your construction is right and counts for this skill; only this detail is a slip.
      </p>
    </div>
  );
}

