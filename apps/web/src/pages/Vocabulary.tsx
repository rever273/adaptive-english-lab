import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, addVocabulary, createVocabSession, fetchVocabPractice, fetchVocabulary, patchVocabulary, removeVocabulary, type VocabEntry, type VocabPracticeStatus } from "../api";
import { Practice } from "./Practice";
import { Kbd, isTextField, useKeys } from "../components/hotkeys";

const POS = ["noun", "verb", "adjective", "adverb", "preposition", "conjunction", "pronoun", "determiner", "phrase", "phrasal verb", "idiom", "other"];
const LEVEL_NAME: Record<string, string> = { A1: "beginner", A2: "elementary", B1: "intermediate", B2: "upper intermediate", C1: "advanced", C2: "proficient" };
/** the six CEFR levels as six blocks: A1 fills one, C2 fills all six; the blocks run from green to red */
const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];
const AI_TIP = "Written by the local AI. Edit it to make it yours.";

/** text written by the AI is simply shown in blue (with a tooltip); the learner's own text is plain */
function Txt({ text, source, empty }: { text: string; source: "user" | "ai_draft" | null; empty: string }) {
  if (!text) return <span className="muted">{empty}</span>;
  return source === "ai_draft" ? <span className="ai-text" title={AI_TIP}>{text}</span> : <>{text}</>;
}

/** the word with six small blocks under it, filled up to its level (A1 = one, C2 = six); hovering shows the level */
function Word({ w }: { w: VocabEntry }) {
  const n = w.level ? LEVELS.indexOf(w.level) + 1 : 0;
  if (n === 0) return <strong className="word">{w.lemma}</strong>;
  return (
    <span className="word-lvl" tabIndex={0} data-tip={`${w.level} · ${LEVEL_NAME[w.level!] ?? ""} (AI estimate)`} aria-label={`${w.lemma}, level ${w.level} (AI estimate)`}>
      <strong className="word">{w.lemma}</strong>
      <span className="lvl-segs" aria-hidden="true">
        {LEVELS.map((l, i) => (
          <i key={l} className={i < n ? `on s${i}` : ""} />
        ))}
      </span>
    </span>
  );
}

function Row({ w, onChanged }: { w: VocabEntry; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  // the fields start with what is shown (your text or the AI draft), so a small fix is just a few keystrokes
  const [tr, setTr] = useState(w.translation.text);
  const [ex, setEx] = useState(w.example.text);
  const [co, setCo] = useState(w.collocations.items.join(", "));
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [pos, setPos] = useState(w.pos === "unknown" ? "" : w.pos);
  const [msg, setMsg] = useState<string | null>(null);
  const [rev, setRev] = useState(w.userRevision);
  useEffect(() => setRev(w.userRevision), [w.userRevision]);

  const save = async () => {
    setMsg(null);
    try {
      await patchVocabulary(w.id, { expectedRevision: rev, translationRu: tr, exampleEn: ex, collocations: co.split(",").map((x) => x.trim()).filter(Boolean), ...(pos ? { pos } : {}) });
      setOpen(false);
      onChanged();
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === "REVISION_CONFLICT") {
        const cur = (e.details as { current?: VocabEntry; currentRevision?: number } | null)?.current;
        if (cur) setRev(cur.userRevision);
        setMsg(`${e.message} Current translation: “${cur?.translation.text ?? ""}”. Check it and press Save again if you still want your version.`);
        onChanged();
      } else setMsg(e instanceof ApiRequestError ? e.message : "Could not save.");
    }
  };
  const remove = async () => {
    setMsg(null);
    try {
      await removeVocabulary(w.id);
      onChanged();
    } catch (e) {
      setMsg(e instanceof ApiRequestError ? e.message : "Could not remove the word.");
      setOpen(true);
    }
  };
  const toggle = async (learned: boolean) => {
    try {
      await patchVocabulary(w.id, { learned });
      onChanged();
    } catch {
      /* the checkbox returns to its saved state on reload */
    }
  };

  return (
    <>
      <tr data-testid="vocab-row" className={w.learned ? "row-learned" : undefined}>
        <td className="c"><input type="checkbox" checked={w.learned} onChange={(e) => void toggle(e.target.checked)} aria-label={`${w.lemma} learned`} /></td>
        <td className="c">
          <Word w={w} />
          {w.surfaceForms.length > 0 && <div className="muted small">{w.surfaceForms.join(", ")}</div>}
        </td>
        <td className="c">
          <Txt text={w.translation.text} source={w.translation.source} empty={w.aiPending ? "waiting for the AI…" : w.aiError ? "AI translation failed — see AI Tasks" : "—"} />
          {w.draftPredatesEdit && <div className="muted small">The AI draft was written before your last edit.</div>}
        </td>
        <td className="c small">{w.pos === "unknown" ? <span className="muted">—</span> : w.posSource === "ai_draft" ? <span className="ai-text" title={AI_TIP}>{w.pos}</span> : w.pos}</td>
        <td className="small example"><Txt text={w.example.text} source={w.example.source} empty={w.aiExampleOmitted ? "AI example unavailable" : "—"} /></td>
        <td className="c num" title="How many vocabulary-practice tasks on this word you have answered (first tries)">{w.practised}</td>
        <td className="c num" title="How many times the word appears in approved exercises">{w.bank.occurrences}</td>
        <td className="c num" title="How many times you were actually shown it">{w.displayed.occurrences}</td>
        <td className="c small nowrap">{w.lastSeen ? new Date(w.lastSeen).toLocaleDateString("en-AU") : "—"}</td>
        <td className="c">
          <div className="icon-actions">
            {confirmRemove ? (
              <>
                <button className="icon-btn icon-btn-danger" onClick={() => void remove()} title={`Remove “${w.lemma}”`} aria-label={`Remove ${w.lemma}`} data-testid="remove-confirm">
                  <i className="pi pi-check" aria-hidden="true" />
                </button>
                <button className="icon-btn" onClick={() => setConfirmRemove(false)} title="Keep the word" aria-label="Keep the word">
                  <i className="pi pi-times" aria-hidden="true" />
                </button>
              </>
            ) : (
              <>
                <button className={`icon-btn${open ? " icon-btn-on" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open} title={open ? "Close" : "Edit"} aria-label={open ? "Close" : `Edit ${w.lemma}`}>
                  <i className={`pi ${open ? "pi-times" : "pi-pencil"}`} aria-hidden="true" />
                </button>
                <button className="icon-btn icon-btn-danger" onClick={() => setConfirmRemove(true)} title="Remove" aria-label={`Remove ${w.lemma}`} data-testid="remove-word">
                  <i className="pi pi-trash" aria-hidden="true" />
                </button>
              </>
            )}
          </div>
          {confirmRemove && <div className="small muted">Remove?</div>}
        </td>
      </tr>
      {open && (
        <tr className="edit-row">
          <td colSpan={10}>
            {msg && <p className="notice notice-warn small" role="alert">{msg}</p>}
            <div className="form-grid">
              <label>Translation (Russian)<input value={tr} onChange={(e) => setTr(e.target.value)} /></label>
              <label>Part of speech<select value={pos} onChange={(e) => setPos(e.target.value)}><option value="">(not set)</option>{POS.map((p) => <option key={p}>{p}</option>)}</select></label>
              <label>Example<input value={ex} onChange={(e) => setEx(e.target.value)} /></label>
              <label>Collocations (comma separated)<input value={co} onChange={(e) => setCo(e.target.value)} /></label>
            </div>
            <div className="actions">
              <button className="btn btn-primary" onClick={() => void save()}><i className="pi pi-check" aria-hidden="true" /> Save</button>
              <span className="muted small">Saving makes this text yours: the AI never overwrites it.</span>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

const loadPref = (): boolean => {
  try {
    return localStorage.getItem("vocab.notLearned") === "1";
  } catch {
    return false;
  }
};

/** Vocabulary Practice: a short vocabulary-only session from approved exercises for the words in this dictionary (no flashcards, no timer) */
function PracticeBlock({ status, onStart, onStudio, error }: { status: VocabPracticeStatus | null; onStart: (count?: number) => void; onStudio: () => void; error: string | null }) {
  if (!status) return null;
  const short = status.shortage;
  return (
    <div className="vocab-practice" data-testid="vocab-practice">
      <div className="vocab-practice-main">
        <div>
          <h3><i className="pi pi-bolt" aria-hidden="true" /> Vocabulary Practice</h3>
          <p className="muted small">Short tasks with your words in new sentences: choose the word, type it, or pick its natural partner. No timer; “I don’t know” and Skip are always there.</p>
        </div>
        <button className="btn btn-primary btn-big has-kbd" disabled={status.available === 0} onClick={() => onStart(short ? status.available : undefined)} data-testid="start-vocab">
          <Kbd k="P" />
          <i className="pi pi-play" aria-hidden="true" /> {short && status.available > 0 ? `Practise ${status.available} task${status.available === 1 ? "" : "s"}` : `Practise vocabulary · ${status.taskCount} tasks`}
        </button>
      </div>
      <div className="mini-stats" role="list">
        <span role="listitem" title="Approved exercises for your words whose sentences you have never seen"><strong>{status.freshAvailable ?? status.available}</strong> new exercises</span>
        {(status.repeatStock ?? 0) > 0 && <span role="listitem" title="Sentences you have seen before. Some may come back with a Repeat label, mostly after a miss"><strong>{status.repeatStock}</strong> previously seen sentences</span>}
        <span role="listitem" title="Words that have at least one new approved exercise"><strong>{status.wordsWithContexts}</strong> words ready</span>
        <span role="listitem"><strong>{status.words}</strong> words saved</span>
        <span role="listitem"><strong>{status.learned}</strong> marked learned</span>
        {status.draftsNotReleased > 0 && <span role="listitem" title="Exercises that are not approved and released are never offered"><strong>{status.draftsNotReleased}</strong> not released</span>}
      </div>
      {short && (
        <p className="notice notice-warn small" data-testid="vocab-shortage">
          <i className="pi pi-info-circle" aria-hidden="true" /> {short.message}{" "}
          <button className="link" onClick={onStudio}>Open Content Studio → Vocabulary</button>
        </p>
      )}
      {error && <p className="notice notice-error small" role="alert">{error}</p>}
    </div>
  );
}

export function Vocabulary({ onNavigate }: { onNavigate?: (page: "vocabulary" | "analytics" | "studio") => void } = {}) {
  const [words, setWords] = useState<VocabEntry[] | null>(null);
  const [practice, setPractice] = useState<VocabPracticeStatus | null>(null);
  const [practising, setPractising] = useState(false);
  const searchBox = useRef<HTMLInputElement>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [totals, setTotals] = useState<{ words: number; learned: number; bankOccurrences: number; displayedOccurrences: number } | null>(null);
  const [q, setQ] = useState("");
  const [newWord, setNewWord] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notLearned, setNotLearned] = useState(loadPref);

  const loadPractice = useCallback(async () => {
    try {
      const st = await fetchVocabPractice();
      setPractice(st);
      if (st.activeSessionId) setPractising(true); // an open vocabulary session continues where it was left
    } catch {
      /* the dictionary works without it */
    }
  }, []);
  useEffect(() => {
    void loadPractice();
  }, [loadPractice]);

  const start = async (count?: number) => {
    setStartError(null);
    try {
      await createVocabSession(count);
      setPractising(true);
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === "SESSION_ACTIVE") setStartError("Another session is still open. Finish it first (Practice tab, or here if it is a vocabulary session).");
      else setStartError(e instanceof ApiRequestError ? e.message : "Could not start the session.");
      void loadPractice();
    }
  };

  const load = useCallback(async () => {
    try {
      const r = await fetchVocabulary(q);
      setWords(r.words);
      setTotals(r.totals);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Cannot load the vocabulary.");
    }
  }, [q]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 6000); // picks up AI drafts as they arrive
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    try {
      localStorage.setItem("vocab.notLearned", notLearned ? "1" : "0");
    } catch {
      /* a convenience only */
    }
  }, [notLearned]);

  const add = async () => {
    setError(null);
    try {
      await addVocabulary(newWord);
      setNewWord("");
      await load();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not save the word.");
    }
  };

  const shown = (words ?? []).filter((w) => !notLearned || !w.learned);
  // keys: P starts a practice session, / jumps to the search box (never while typing)
  useKeys((e) => {
    if (practising || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTextField(e.target)) return;
    if (e.key === "/") {
      e.preventDefault();
      searchBox.current?.focus();
    } else if (e.key.toLowerCase() === "p" && practice && practice.available > 0 && !(e.target instanceof HTMLElement && e.target.closest("button, a"))) {
      e.preventDefault();
      void start(practice.shortage ? practice.available : undefined);
    }
  });
  if (practising) {
    return (
      <Practice
        category="vocabulary"
        onExit={() => {
          setPractising(false);
          void loadPractice();
          void load();
        }}
        onNavigate={(pg) => onNavigate?.(pg)}
      />
    );
  }
  return (
    <section className="card" aria-labelledby="vo-h">
      <h2 id="vo-h"><i className="pi pi-bookmark" aria-hidden="true" /> Vocabulary</h2>
      <p className="lede">Words you saved while practising. Saving is instant; the local AI adds a translation in the background (shown in <span className="ai-text">blue</span>), and anything you write yourself is never replaced. The dotted line under a word shows its level, from green (A1) to red (C2) — hover to see it.</p>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      <PracticeBlock status={practice} onStart={(c) => void start(c)} onStudio={() => onNavigate?.("studio")} error={startError} />
      <div className="toolbar">
        <div className="field-add">
          <input value={newWord} onChange={(e) => setNewWord(e.target.value)} onKeyDown={(e) => e.key === "Enter" && newWord.trim() && void add()} placeholder="Add a word or a short phrase" aria-label="Add a word" data-testid="new-word" />
          <button className="btn btn-ok" disabled={!newWord.trim()} onClick={() => void add()}><i className="pi pi-plus" aria-hidden="true" /> Add</button>
        </div>
        <div className="field-search">
          <i className="pi pi-search" aria-hidden="true" />
          <input ref={searchBox} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search words" />
          <kbd className="slash-key" aria-hidden="true">/</kbd>
        </div>
        <label className="inline toggle"><input type="checkbox" checked={notLearned} onChange={(e) => setNotLearned(e.target.checked)} data-testid="only-not-learned" /> Only words I have not learned</label>
      </div>
      {totals && (
        <p className="muted small" data-testid="vocab-totals">
          {totals.words} words · {totals.learned} marked learned · seen in approved exercises {totals.bankOccurrences} times, actually shown to you {totals.displayedOccurrences} times (counted separately)
        </p>
      )}
      {words === null ? (
        <p role="status">Loading…</p>
      ) : words.length === 0 ? (
        <p className="muted">Nothing saved yet. While you practise, select a word in the exercise and press “Add to vocabulary”.</p>
      ) : shown.length === 0 ? (
        <p className="muted">Every word here is marked learned. Untick the filter to see them.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table" data-testid="vocab-table">
            <thead>
              <tr>
                <th title="Learned"><i className="pi pi-check-square" aria-hidden="true" /><span className="visually-hidden">Learned</span></th>
                <th>Word</th>
                <th>Translation</th>
                <th>Part of speech</th>
                <th>Example</th>
                <th title="Vocabulary-practice tasks on this word that you have answered">Practised</th>
                <th title="Occurrences in approved exercises">In exercises</th>
                <th title="Times you were actually shown the word">Shown to you</th>
                <th>Last shown</th>
                <th><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>{shown.map((w) => <Row key={`${w.id}:${w.userRevision}:${w.translation.text}`} w={w} onChanged={() => void load()} />)}</tbody>
          </table>
        </div>
      )}
      <p className="muted small">Newest shown first. Marking a word learned does not change any score.</p>
    </section>
  );
}
