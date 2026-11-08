import { useCallback, useEffect, useState } from "react";
import { NumberInput } from "../components/NumberInput";
import { ApiRequestError, fetchWordLessonStudio, generateWordLessons, retryWordLessons, type WordLessonStudioStatus } from "../api";

const REASON: Record<string, string> = {
  lesson_review_rejected: "the reviewing pass still found problems after the lesson was rewritten",
  lesson_review_failed: "the reviewing answer could not be read",
  lesson_stage_failed: "one step could not be written in the required form",
  lesson_invalid: "the finished lesson did not pass the final check",
  transport_failed: "the model server did not answer",
  model_digest_mismatch: "the installed model differs from the pinned one",
};
const errorText = (e: unknown) => (e instanceof ApiRequestError ? e.message : "Something went wrong.");

/**
 * Content Studio → Vocabulary: lessons for the single-word practice. Pick how many words; the app chooses them itself, the ones you know worst first.
 * A lesson appears in Vocabulary only when all five stages were written and checked, so an interrupted pack leaves the finished lessons and nothing half-made.
 */
export function WordLessonStudio() {
  const [st, setSt] = useState<WordLessonStudioStatus | null>(null);
  const [count, setCount] = useState(10);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await fetchWordLessonStudio();
      setSt(s);
      setCount((c) => (touched ? Math.min(c, s.maxCount) : s.defaultCount));
    } catch (e) {
      setError(errorText(e));
    }
  }, [touched]);
  useEffect(() => {
    void load();
  }, [load]);
  const generating = (st?.generating ?? 0) > 0;
  useEffect(() => {
    if (!generating) return;
    const t = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(t);
  }, [generating, load]);

  const act = async <R extends { status: WordLessonStudioStatus }>(fn: () => Promise<R>, message: (r: R) => string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await fn();
      setSt(r.status);
      setNote(message(r));
      setTouched(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="wls-h" data-testid="word-lesson-studio">
      <h2 id="wls-h"><i className="pi pi-star" aria-hidden="true" /> Single word lessons</h2>
      <p className="lede">A full five-step lesson for one saved word: examples, recall, sentence transformation, building a sentence from meaning and a sentence of your own. The words are chosen for you, the ones you know worst first. A lesson appears in Vocabulary only when every step was written and checked.</p>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {note && <p className="notice notice-info" role="status">{note}</p>}
      {st && (
        <>
          <p data-testid="word-lesson-coverage"><strong>{st.ready} / {st.eligible}</strong> words ready</p>
          <p className="muted small">
            {st.candidates} word{st.candidates === 1 ? "" : "s"} without a lesson
            {st.generating > 0 && ` · ${st.generating} being written`}
            {st.waitingTranslation > 0 && ` · ${st.waitingTranslation} waiting for a translation`}
            {st.disputed > 0 && ` · ${st.disputed} answer${st.disputed === 1 ? "" : "s"} you disagreed with, saved for review`}
          </p>
          <p className="muted small">Sentence difficulty: {st.difficulty.min === st.difficulty.max ? st.difficulty.min : `${st.difficulty.min} to ${st.difficulty.max}`} (change it in Settings).</p>
          <div className="actions">
            <label className="inline">
              <span>Words to prepare</span>
              <NumberInput min={1} max={st.maxCount} value={count} aria-label="Words to prepare" data-testid="word-lesson-count" onChange={(value) => { setTouched(true); setCount(value); }} />
            </label>
            <button className="btn btn-primary" disabled={busy || st.candidates === 0} data-testid="word-lesson-generate" onClick={() => void act(() => generateWordLessons(count), (r) => `Started ${r.created} lesson${r.created === 1 ? "" : "s"}. Progress is shown in AI Tasks.`)}>
              Generate lessons
            </button>
            {st.failed > 0 && (
              <button className="btn" disabled={busy} data-testid="word-lesson-retry" onClick={() => void act(() => retryWordLessons(), (r) => `Trying ${r.queued} lesson${r.queued === 1 ? "" : "s"} again.`)}>
                Retry {st.failed} failed
              </button>
            )}
          </div>
          {st.failures.length > 0 && (
            <details data-testid="word-lesson-failures">
              <summary className="small">Why {st.failures.length} lesson{st.failures.length === 1 ? "" : "s"} failed</summary>
              <ul className="small">
                {st.failures.map((f) => (
                  <li key={f.lemma}>
                    <strong>{f.lemma}</strong>: {REASON[f.code ?? ""] ?? f.code ?? "unknown"}
                    {f.remarks.length > 0 && <ul>{f.remarks.map((r, i) => <li key={i} className="muted">{r}</li>)}</ul>}
                  </li>
                ))}
              </ul>
              <p className="muted small">A retry writes the lesson from scratch.</p>
            </details>
          )}
          {st.candidates === 0 && st.eligible > 0 && st.failed === 0 && st.generating === 0 && <p className="muted small">Every word that has a translation has a lesson.</p>}
          {st.eligible === 0 && <p className="muted">Save some words first (with a translation); then lessons can be made for them.</p>}
        </>
      )}
    </section>
  );
}
