import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, addVocabulary, fetchVocabulary, patchVocabulary, type VocabEntry } from "../api";

const POS = ["noun", "verb", "adjective", "adverb", "preposition", "conjunction", "pronoun", "determiner", "phrase", "phrasal verb", "idiom", "other"];
const SRC: Record<string, string> = { user: "yours", ai_draft: "AI draft" };

function Src({ s }: { s: "user" | "ai_draft" | null }) {
  return s === "ai_draft" ? <span className="badge badge-info" title="Written by the local AI. Edit it to make it yours.">AI draft</span> : null;
}

function Row({ w, onChanged }: { w: VocabEntry; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [tr, setTr] = useState(w.translation.source === "user" ? w.translation.text : "");
  const [ex, setEx] = useState(w.example.source === "user" ? w.example.text : "");
  const [co, setCo] = useState(w.collocations.source === "user" ? w.collocations.items.join(", ") : "");
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
      <tr data-testid="vocab-row">
        <td><strong>{w.lemma}</strong>{w.surfaceForms.length > 0 && <div className="muted small">{w.surfaceForms.join(", ")}</div>}</td>
        <td>{w.translation.text || <span className="muted">{w.aiPending ? "waiting for the AI…" : "—"}</span>} <Src s={w.translation.source} />{w.draftPredatesEdit && <div className="muted small">The AI draft was written before your last edit.</div>}</td>
        <td>{w.pos === "unknown" ? <span className="muted">—</span> : w.pos}</td>
        <td className="small">{w.example.text || "—"} <Src s={w.example.source} /></td>
        <td className="small" title="In exercises = how many times the word appears in approved exercises. Shown = how many times you were actually shown it.">in exercises {w.bank.occurrences} · shown {w.displayed.occurrences}</td>
        <td><input type="checkbox" checked={w.learned} onChange={(e) => void toggle(e.target.checked)} aria-label={`${w.lemma} learned`} /></td>
        <td className="small">{w.lastSeen ? new Date(w.lastSeen).toLocaleDateString() : "—"}</td>
        <td><button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Close" : "Edit"}</button></td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8}>
            {msg && <p className="notice notice-warn small" role="alert">{msg}</p>}
            <div className="form-grid">
              <label>Translation (Russian)<input value={tr} onChange={(e) => setTr(e.target.value)} placeholder={w.translation.source === "ai_draft" ? w.translation.text : ""} /></label>
              <label>Part of speech<select value={pos} onChange={(e) => setPos(e.target.value)}><option value="">(not set)</option>{POS.map((p) => <option key={p}>{p}</option>)}</select></label>
              <label>Example<input value={ex} onChange={(e) => setEx(e.target.value)} placeholder={w.example.source === "ai_draft" ? w.example.text : ""} /></label>
              <label>Collocations (comma separated)<input value={co} onChange={(e) => setCo(e.target.value)} placeholder={w.collocations.source === "ai_draft" ? w.collocations.items.join(", ") : ""} /></label>
            </div>
            <div className="actions"><button className="btn btn-primary" onClick={() => void save()}>Save</button></div>
          </td>
        </tr>
      )}
    </>
  );
}

export function Vocabulary() {
  const [words, setWords] = useState<VocabEntry[] | null>(null);
  const [totals, setTotals] = useState<{ words: number; learned: number; bankOccurrences: number; displayedOccurrences: number } | null>(null);
  const [q, setQ] = useState("");
  const [newWord, setNewWord] = useState("");
  const [error, setError] = useState<string | null>(null);

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

  return (
    <section className="card" aria-labelledby="vo-h">
      <h2 id="vo-h">Vocabulary</h2>
      <p className="lede">Words you saved while practising. Saving is instant. The AI adds a draft translation in the background, and anything you write yourself is never replaced. There are no flashcards or schedules here.</p>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      <div className="actions">
        <label className="inline"><span className="small">Add a word</span><input value={newWord} onChange={(e) => setNewWord(e.target.value)} onKeyDown={(e) => e.key === "Enter" && newWord.trim() && void add()} aria-label="Add a word" data-testid="new-word" /></label>
        <button className="btn" disabled={!newWord.trim()} onClick={() => void add()}>Save</button>
        <label className="inline"><span className="small">Search</span><input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search words" /></label>
      </div>
      {totals && <p className="muted small" data-testid="vocab-totals">{totals.words} words · {totals.learned} marked learned · seen in approved exercises {totals.bankOccurrences} times, actually shown to you {totals.displayedOccurrences} times (counted separately)</p>}
      {words === null ? (
        <p role="status">Loading…</p>
      ) : words.length === 0 ? (
        <p className="muted">Nothing saved yet. While you practise, select a word and press “+ Add to vocabulary”.</p>
      ) : (
        <div className="table-wrap">
          <table className="summary-table wide" data-testid="vocab-table">
            <thead><tr><th>Word</th><th>Translation</th><th>Part of speech</th><th>Example</th><th>Encounters</th><th>Learned</th><th>Last shown</th><th /></tr></thead>
            <tbody>{words.map((w) => <Row key={`${w.id}:${w.userRevision}:${w.translation.text}`} w={w} onChanged={() => void load()} />)}</tbody>
          </table>
        </div>
      )}
      <p className="muted small">AI drafts are labelled “{SRC.ai_draft}”. Marking a word learned does not change any score.</p>
    </section>
  );
}
