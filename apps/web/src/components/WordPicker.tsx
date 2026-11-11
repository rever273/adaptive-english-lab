import { useEffect, useMemo, useRef, useState } from "react";
import type { WordLessonListItem } from "@english-lab/contracts";

/** the text of one row: the English word with the Russian translation in brackets */
export const lessonLabel = (l: Pick<WordLessonListItem, "lemma" | "translationRu">): string => `${l.lemma} (${l.translationRu})`;

/** rows drawn at first and added each time the end of the table is reached; the box shows about ten of them, so it always has something to scroll */
const PAGE = 20;

const dateOf = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

/**
 * The words that have a ready lesson, as a table for Single Word Practice. About ten rows are visible; more load as you scroll to the end.
 * Words not finished yet come first (in progress ones marked); words finished at least once are green, at the very end, with their statistics
 * (passes, last score, last date). "Hide learned words" removes the green ones. The search box filters by the English word or the translation.
 */
export function WordTable({ lessons, hideCompleted, onPick, inputRef }: { lessons: readonly WordLessonListItem[]; hideCompleted: boolean; onPick: (l: WordLessonListItem) => void; inputRef?: React.RefObject<HTMLInputElement | null> }) {
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(PAGE);
  const own = useRef<HTMLInputElement | null>(null);
  const field = inputRef ?? own;
  const box = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();
  const rows = useMemo(() => {
    const open = lessons.filter((l) => (!hideCompleted || l.completedRuns === 0) && (q === "" || l.lemma.toLowerCase().includes(q) || l.translationRu.toLowerCase().includes(q)));
    // new words first (a word being worked on before the rest), finished ones last; each group stays alphabetical
    const rank = (l: WordLessonListItem) => (l.completedRuns > 0 ? 2 : l.activeRunId ? 0 : 1);
    return [...open].sort((a, b) => rank(a) - rank(b) || a.lemma.localeCompare(b.lemma));
  }, [lessons, hideCompleted, q]);
  useEffect(() => {
    setCount(PAGE);
    if (box.current) box.current.scrollTop = 0;
  }, [q, hideCompleted]);
  useEffect(() => {
    const el = end.current;
    const root = box.current;
    if (!el || !root || count >= rows.length) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) setCount((n) => n + PAGE); }, { root, rootMargin: "120px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [count, rows.length]);
  const shown = rows.slice(0, count);
  const focusRow = (from: Element | null, step: 1 | -1) => {
    const list = Array.from(box.current?.querySelectorAll<HTMLElement>("tbody tr[tabindex]") ?? []);
    const i = from ? list.indexOf(from as HTMLElement) : -1;
    const next = list[i + step];
    if (next) next.focus();
    else if (step === -1) field.current?.focus();
    else if (shown.length < rows.length) setCount((n) => n + PAGE);
  };
  const doneCount = lessons.filter((l) => l.completedRuns > 0).length;
  return (
    <div className="wl-table-wrap">
      <input
        ref={field}
        className="wl-picker-input"
        type="search"
        aria-label="Search the words of the single-word lessons"
        placeholder={lessons.length === 0 ? "No lessons yet" : "Search by word or translation"}
        autoComplete="off"
        spellCheck={false}
        value={query}
        disabled={lessons.length === 0}
        data-testid="word-picker"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && rows[0]) { e.preventDefault(); onPick(rows[0]); }
          else if (e.key === "ArrowDown") { e.preventDefault(); box.current?.querySelector<HTMLElement>("tbody tr[tabindex]")?.focus(); }
        }}
      />
      <div className="wl-table-box" ref={box} data-testid="word-table">
        <table className="wl-table">
          <thead>
            <tr><th scope="col">Word</th><th scope="col">Translation</th><th scope="col" className="wl-num">Passes</th><th scope="col" className="wl-num">Last score</th><th scope="col">Last pass</th></tr>
          </thead>
          <tbody>
            {shown.map((l) => (
              <tr
                key={l.lessonId}
                tabIndex={0}
                className={l.completedRuns > 0 ? "wl-row-done" : l.activeRunId ? "wl-row-active" : undefined}
                onClick={() => onPick(l)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(l); }
                  else if (e.key === "ArrowDown") { e.preventDefault(); focusRow(e.currentTarget, 1); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); focusRow(e.currentTarget, -1); }
                }}
              >
                <td className="wl-word">{l.lemma}{l.activeRunId && l.completedRuns === 0 && <span className="muted small"> · in progress</span>}</td>
                <td>{l.translationRu}</td>
                {l.completedRuns > 0 ? (
                  <>
                    <td className="wl-num"><i className="pi pi-check" aria-hidden="true" /> {l.completedRuns}</td>
                    <td className="wl-num" title="The score of the last pass">{l.lastScore ?? 0}/100</td>
                    <td>{dateOf(l.lastCompletedAt)}</td>
                  </>
                ) : (
                  <td colSpan={3} className="muted small">{l.activeRunId ? "continue" : "new"}</td>
                )}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr className="wl-table-empty"><td colSpan={5} className="muted small">{lessons.length === 0 ? "No lessons yet." : q ? "No word matches." : "Every lesson has been finished. Untick “Hide learned words” to repeat one."}</td></tr>
            )}
          </tbody>
        </table>
        <div ref={end} className="wl-table-end" aria-hidden="true" />
      </div>
      <p className="muted small" data-testid="word-table-count">
        {rows.length} word{rows.length === 1 ? "" : "s"}{hideCompleted && doneCount > 0 ? ` (${doneCount} learned hidden)` : ""}
      </p>
    </div>
  );
}
