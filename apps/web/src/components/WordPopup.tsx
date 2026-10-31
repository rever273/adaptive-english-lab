import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, addVocabulary, lookupVocabulary, type VocabEntry } from "../api";

const LETTER = /[\p{L}'’-]/u;
/** a word or a short phrase of up to three English words; a sentence (punctuation inside, more words) or Russian text never matches */
const PHRASE = /^[A-Za-z][A-Za-z'’-]*(?: [A-Za-z][A-Za-z'’-]*){0,2}$/;
const IGNORE = ".word-panel, input, textarea, select, [contenteditable=true], [data-no-word]";

/** the selection grown to whole words when it starts or ends inside a word ("sen" -> "sentence") */
function wholeWords(sel: Selection): string {
  const text = sel.toString();
  if (sel.rangeCount !== 1) return text;
  const r = sel.getRangeAt(0);
  if (r.startContainer !== r.endContainer || r.startContainer.nodeType !== Node.TEXT_NODE) return text;
  const s = r.startContainer.textContent ?? "";
  let a = r.startOffset;
  let b = r.endOffset;
  while (a > 0 && LETTER.test(s[a - 1]!)) a--;
  while (b < s.length && LETTER.test(s[b]!)) b++;
  return s.slice(a, b);
}

const elementOf = (n: Node | null): Element | null => (n?.nodeType === Node.ELEMENT_NODE ? (n as Element) : (n?.parentElement ?? null));

/** what is selected, if it is a word or short phrase worth saving: nothing for a sentence, Russian text, or a selection inside a form field */
export function readWordSelection(): { text: string; slotId?: string } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const a = elementOf(sel.anchorNode);
  const f = elementOf(sel.focusNode);
  if (!a || !f || a.closest(IGNORE) || f.closest(IGNORE)) return null;
  const text = wholeWords(sel).replace(/\s+/g, " ").trim().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
  if (text.length === 0 || text.length > 40 || !PHRASE.test(text)) return null;
  return { text, slotId: a.closest("[data-slot-id]")?.getAttribute("data-slot-id") ?? undefined };
}

/**
 * Select an English word or a short phrase ANYWHERE in the app and a small panel (bottom left, like the AI panel on the right) offers to save
 * it, or shows what is already saved. A whole sentence is ignored. Saving is instant and never waits for the AI; the task the word was met
 * in (when there is one) becomes the context for its translation. The panel never takes focus and keeps the selection while it is used.
 */
export function WordCatcher() {
  const [pick, setPick] = useState<{ text: string; slotId?: string } | null>(null);
  const [known, setKnown] = useState<VocabEntry | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const read = useCallback(() => {
    const r = readWordSelection();
    setPick((cur) => {
      if (r?.text === cur?.text && r?.slotId === cur?.slotId) return cur;
      setSaved(null);
      setError(null);
      return r;
    });
  }, []);

  useEffect(() => {
    const onChange = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(read, 180);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("selectionchange", onChange);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [read]);

  const text = pick?.text ?? null;
  useEffect(() => {
    let off = false;
    setKnown(null);
    if (!text) return;
    lookupVocabulary(text)
      .then((r) => !off && setKnown(r.entry))
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [text]);

  const add = async () => {
    if (!pick) return;
    try {
      const e = await addVocabulary(pick.text.toLowerCase(), pick.text, pick.slotId);
      setKnown(e);
      setSaved(`Saved “${e.lemma}”. The translation is filled in later if the local AI is free.`);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not save the word.");
    }
  };

  if (!pick) return null;
  return (
    <aside className="word-panel" aria-label="Save a word" aria-live="polite" data-testid="word-bar" onMouseDown={(e) => e.preventDefault()}>
      <header className="word-panel-head">
        <span><i className="pi pi-bookmark" aria-hidden="true" /> Vocabulary</span>
        <button type="button" className="icon-btn" onClick={() => setPick(null)} aria-label="Close" title="Close"><i className="pi pi-times" aria-hidden="true" /></button>
      </header>
      <p className="word-panel-word">{pick.text}</p>
      {!known && !saved && (
        <button type="button" className="btn btn-ok btn-small" onClick={() => void add()} data-testid="add-word">
          <i className="pi pi-plus" aria-hidden="true" /> Add to vocabulary
        </button>
      )}
      {known && !saved && (
        <p className="small" data-testid="known-word">
          <i className="pi pi-bookmark-fill" aria-hidden="true" /> Already saved{known.learned ? " · learned" : ""}.{" "}
          {known.translation.text ? <span className={known.translation.source === "ai_draft" ? "ai-text" : undefined}>{known.translation.text}</span> : <span className="muted">No translation yet.</span>}
        </p>
      )}
      {saved && <p className="small" role="status" data-testid="word-saved">{saved}</p>}
      {error && <p className="small notice notice-error" role="alert">{error}</p>}
    </aside>
  );
}
