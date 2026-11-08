import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { WordLessonListItem } from "@english-lab/contracts";

/** the text of one row: the English word with the Russian translation in brackets */
export const lessonLabel = (l: Pick<WordLessonListItem, "lemma" | "translationRu">): string => `${l.lemma} (${l.translationRu})`;

/**
 * A wide, searchable word list for Single Word Context Practice. Click it or start typing to filter by the English word or the translation;
 * arrows and Enter pick one. A word whose lesson was finished at least once has a green tick and the result of its last pass; those are hidden
 * unless "Show completed words" is on.
 */
export function WordPicker({ lessons, showCompleted, onPick, inputRef }: { lessons: readonly WordLessonListItem[]; showCompleted: boolean; onPick: (l: WordLessonListItem) => void; inputRef?: React.RefObject<HTMLInputElement | null> }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const own = useRef<HTMLInputElement | null>(null);
  const field = inputRef ?? own;
  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () => lessons.filter((l) => (showCompleted || l.completedRuns === 0) && (q === "" || l.lemma.toLowerCase().includes(q) || l.translationRu.toLowerCase().includes(q))),
    [lessons, showCompleted, q],
  );
  useEffect(() => setActive(0), [q, showCompleted]);
  const choose = (l: WordLessonListItem) => {
    setOpen(false);
    setQuery("");
    onPick(l);
  };
  return (
    <div className="wl-picker">
      <input
        ref={field}
        className="wl-picker-input"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && shown[active] ? `${listId}-${active}` : undefined}
        aria-label="Choose a word for a single-word lesson"
        placeholder={lessons.length === 0 ? "No lessons yet" : "Choose a word, or type to search"}
        autoComplete="off"
        spellCheck={false}
        value={query}
        disabled={lessons.length === 0}
        data-testid="word-picker"
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(shown.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter" && open && shown[active]) {
            e.preventDefault();
            choose(shown[active]!);
          } else if (e.key === "Escape") setOpen(false);
        }}
      />
      <i className="pi pi-chevron-down wl-picker-caret" aria-hidden="true" />
      {open && (
        <ul id={listId} role="listbox" className="wl-picker-list" data-testid="word-picker-list">
          {shown.length === 0 && <li className="wl-picker-empty muted small">{lessons.length === 0 ? "No lessons yet." : q ? "No word matches." : "Every lesson has been finished. Tick “Show completed words” to repeat one."}</li>}
          {shown.map((l, i) => (
            <li
              key={l.lessonId}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`wl-picker-row${i === active ? " wl-picker-on" : ""}${l.completedRuns > 0 ? " wl-picker-done" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault(); // keep the focus in the box so the list does not close before the click
                choose(l);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="wl-picker-word">{lessonLabel(l)}</span>
              {l.activeRunId && l.completedRuns === 0 && <span className="muted small">in progress</span>}
              {l.completedRuns > 0 && (
                <span className="wl-picker-score" title={`Finished ${l.completedRuns} time${l.completedRuns === 1 ? "" : "s"}; the score is for the last pass`}>
                  <i className="pi pi-check" aria-hidden="true" /> {l.lastScore ?? 0}/100
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
