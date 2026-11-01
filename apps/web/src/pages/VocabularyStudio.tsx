import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, fetchVocabCoverage, type VocabCoverageWord } from "../api";
import { vocabCoverageCache } from "./studioCache";

/**
 * Content Studio → Vocabulary: coverage per dictionary word and the way to get more exercises. New vocabulary exercises are written by the
 * coding agent and checked item by item by a different reviewer before `npm run pack -- publish` (D62); drafts are never offered.
 */
const PAGE_SIZE = 20;

export function VocabularyStudio() {
  const [cov, setCov] = useState<Awaited<ReturnType<typeof fetchVocabCoverage>> | null>(() => vocabCoverageCache.peek());
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const scrollArea = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async (force = false) => {
    try {
      setCov(await vocabCoverageCache.get(force));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Cannot load vocabulary coverage.");
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(true), 10_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !cov || visible >= cov.words.length || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setVisible(n => Math.min(n + PAGE_SIZE, cov.words.length));
    }, { root: scrollArea.current, rootMargin: "0px 0px 160px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [cov?.words.length, visible]);

  const need = (w: VocabCoverageWord) => (w.available === 0 ? "none left" : w.available < 3 ? "low" : "ok");
  return (
    <section className="card" aria-labelledby="vs-h" data-testid="vocab-studio">
      <h2 id="vs-h"><i className="pi pi-bookmark" aria-hidden="true" /> Vocabulary exercises</h2>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {cov && (
        <>
          {cov.words.length === 0 ? (
            <p className="muted">Your dictionary is empty. Save words while practising first.</p>
          ) : (
            <>
            <div className="table-wrap vocab-coverage-scroll" ref={scrollArea} tabIndex={0} role="region" aria-label="Vocabulary coverage table">
              <table className="data-table" data-testid="vocab-coverage">
                <thead>
                  <tr><th>Word</th><th title="Approved, released and never shown or reserved">New</th><th>Word in context</th><th>Recall</th><th>Collocation</th><th title="Approved but already shown to you">Used</th><th title="Drafts, flagged or rejected: never offered">Not released</th><th>Stock</th></tr>
                </thead>
                <tbody>
                  {cov.words.slice(0, visible).map((w) => (
                    <tr key={w.entryId}>
                      <td className="c"><strong>{w.lemma}</strong>{w.learned && <span className="muted small"> · learned</span>}</td>
                      <td className="c num">{w.available}</td>
                      <td className="c num">{w.families.recognition ?? 0}</td>
                      <td className="c num">{w.families.guided_recall ?? 0}</td>
                      <td className="c num">{w.families.collocation ?? 0}</td>
                      <td className="c num">{w.shown}</td>
                      <td className="c num">{w.notReleased}</td>
                      <td className="c"><span className={`stock stock-${need(w).replace(" ", "-")}`}>{need(w)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {visible < cov.words.length && <div ref={sentinel} aria-hidden="true" />}
            </div>
            {visible < cov.words.length && <div className="small muted" aria-live="polite">
              Showing {Math.min(visible, cov.words.length)} of {cov.words.length} words. <button type="button" className="link" onClick={() => setVisible(n => Math.min(n + PAGE_SIZE, cov.words.length))}>Show more</button>
            </div>}
            </>
          )}
          {cov.exercisesForOtherWords > 0 && <p className="muted small">{cov.exercisesForOtherWords} vocabulary exercise(s) are for words that are not in your dictionary; they are offered once you save the word.</p>}
        </>
      )}
    </section>
  );
}
