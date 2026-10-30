import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiRequestError, addVocabulary, lookupVocabulary, type VocabEntry } from "../api";

/**
 * Select any word or short phrase inside the wrapped area and a small bar offers to save it (or shows what is already saved). It is a plain
 * button, reachable by Tab and Enter, announced politely; it never takes focus, never hides the exercise, and saving does not wait for any AI.
 */
export function WordPopup({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [known, setKnown] = useState<VocabEntry | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const read = useCallback(() => {
    const sel = window.getSelection();
    const root = box.current;
    if (!sel || sel.isCollapsed || !root || !sel.anchorNode || !root.contains(sel.anchorNode) || !sel.focusNode || !root.contains(sel.focusNode)) {
      setSelected(null);
      return;
    }
    const text = sel.toString().replace(/\s+/g, " ").trim();
    if (text.length === 0 || text.length > 60 || text.split(" ").length > 4 || !/\p{L}/u.test(text)) {
      setSelected(null);
      return;
    }
    setSelected(text);
    setSaved(null);
    setError(null);
  }, []);

  useEffect(() => {
    const onChange = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(read, 150);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("selectionchange", onChange);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [read]);

  useEffect(() => {
    let off = false;
    setKnown(null);
    if (!selected) return;
    lookupVocabulary(selected)
      .then((r) => !off && setKnown(r.entry))
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [selected]);

  const add = async () => {
    if (!selected) return;
    try {
      const e = await addVocabulary(selected.toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ""), selected);
      setKnown(e);
      setSaved(`Saved “${e.lemma}”. The translation will fill in later if the local AI is available.`);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not save the word.");
    }
  };

  return (
    <div ref={box}>
      {children}
      <div className="word-bar" aria-live="polite" data-testid="word-bar">
        {selected && !known && !saved && (
          <p className="small">
            <span className="muted">Not in your vocabulary yet:</span> <strong>{selected}</strong>{" "}
            <button type="button" className="btn btn-small" onClick={() => void add()} data-testid="add-word">+ Add to vocabulary</button>
          </p>
        )}
        {selected && known && !saved && (
          <p className="small" data-testid="known-word">
            <strong>{known.lemma}</strong> <span className="muted">— saved{known.learned ? ", learned" : ""}.</span> {known.translation.text ? <>{known.translation.text}{known.translation.source === "ai_draft" ? <span className="muted"> (AI draft)</span> : null}</> : <span className="muted">No translation yet.</span>}
          </p>
        )}
        {saved && <p className="small" role="status" data-testid="word-saved">{saved}</p>}
        {error && <p className="small notice notice-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
