import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, addExpression, editExpression, fetchExpressions, removeExpression, retryExpression, type ExpressionView } from "../api";

const AI_TIP = "Written by the local AI. Edit it to make it yours.";

function Row({ e, onChanged }: { e: ExpressionView; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [tr, setTr] = useState(e.translationRu);
  const [ex, setEx] = useState(e.exampleEn);
  const [de, setDe] = useState(e.descriptionRu);
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const cls = e.source === "model" ? "ai-text" : undefined;
  const tip = e.source === "model" ? AI_TIP : undefined;

  const run = async (job: () => Promise<unknown>) => {
    setMsg(null);
    try {
      await job();
      setEditing(false);
      setConfirm(false);
      onChanged();
    } catch (err) {
      setMsg(err instanceof ApiRequestError ? err.message : "Something went wrong.");
    }
  };

  return (
    <tr data-testid="expression-row">
      <td><strong>{e.phrase}</strong></td>
      {editing ? (
        <>
          <td><input value={tr} onChange={(x) => setTr(x.target.value)} aria-label="Translation" /></td>
          <td><input value={ex} onChange={(x) => setEx(x.target.value)} aria-label="Example sentence" /></td>
          <td><input value={de} onChange={(x) => setDe(x.target.value)} aria-label="Description" /></td>
        </>
      ) : e.state === "ready" ? (
        <>
          <td className={cls} title={tip}>{e.translationRu}</td>
          <td className={cls} title={tip}>{e.exampleEn}</td>
          <td className={cls} title={tip}>{e.descriptionRu}</td>
        </>
      ) : (
        <td colSpan={3} className="muted small">
          {e.state === "generating" ? "The local AI is writing the translation, an example and a description…" : "The draft could not be written (the AI may be busy or off)."}{" "}
          {e.state === "failed" && <button className="btn btn-small" onClick={() => void run(() => retryExpression(e.id))}>Try again</button>}
        </td>
      )}
      <td className="actions">
        {editing ? (
          <>
            <button className="btn btn-ok btn-small" onClick={() => void run(() => editExpression(e.id, { translationRu: tr, exampleEn: ex, descriptionRu: de }))}>Save</button>
            <button className="btn btn-small" onClick={() => setEditing(false)}>Cancel</button>
          </>
        ) : confirm ? (
          <>
            <button className="btn btn-small" onClick={() => void run(() => removeExpression(e.id))}>Remove</button>
            <button className="btn btn-small" onClick={() => setConfirm(false)}>Keep</button>
          </>
        ) : (
          <>
            {e.state === "ready" && <button className="btn btn-small" onClick={() => setEditing(true)} aria-label={`Edit ${e.phrase}`}><i className="pi pi-pencil" aria-hidden="true" /></button>}
            <button className="btn btn-small" onClick={() => setConfirm(true)} aria-label={`Remove ${e.phrase}`}><i className="pi pi-trash" aria-hidden="true" /></button>
          </>
        )}
        {msg && <span className="small notice notice-error" role="alert">{msg}</span>}
      </td>
    </tr>
  );
}

/**
 * Expressions: phrases of several words kept next to the words ("harsh weather conditions"). There is no practice mode for them; the local AI
 * writes a translation, an example sentence and a short description, and a saved expression may be used when sentences for its words are made.
 */
export function VocabularyExpressions() {
  const [items, setItems] = useState<ExpressionView[] | null>(null);
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchExpressions().then((r) => setItems(r.expressions)).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);
  // drafts arrive in the background: look again while any is being written
  const waiting = items?.some((x) => x.state === "generating") ?? false;
  useEffect(() => {
    if (!waiting) return;
    const id = window.setInterval(load, 3000);
    return () => window.clearInterval(id);
  }, [waiting, load]);

  const add = async () => {
    setError(null);
    try {
      await addExpression(phrase.trim());
      setPhrase("");
      load();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not save the expression.");
    }
  };

  return (
    <div data-testid="expressions-panel">
      <p className="lede">Phrases you want to remember together with their words. Saving is instant; the local AI then writes a translation, an example and a description (in <span className="ai-text">blue</span>; edit them to make them yours). There is no practice for expressions, but when a word of yours is in one, the AI may use the phrase in that word's practice sentences.</p>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      <div className="toolbar">
        <div className="field-add">
          <input value={phrase} onChange={(e) => setPhrase(e.target.value)} onKeyDown={(e) => e.key === "Enter" && phrase.trim() && void add()} placeholder="Add an expression, for example harsh weather conditions" aria-label="Add an expression" data-testid="new-expression" />
          <button className="btn btn-ok" disabled={!phrase.trim()} onClick={() => void add()}><i className="pi pi-plus" aria-hidden="true" /> Add</button>
        </div>
      </div>
      {items === null ? (
        <p role="status">Loading…</p>
      ) : items.length === 0 ? (
        <p className="muted">No expressions yet. Add one above, or select two or three words in a text and press “Add to expressions”.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table" data-testid="expressions-table">
            <thead>
              <tr><th>Expression</th><th>Translation</th><th>Example</th><th title="Short Russian explanation of what the expression means (written by the local AI)">Description</th><th className="narrow" /></tr>
            </thead>
            <tbody>{items.map((e) => <Row key={`${e.id}:${e.state}:${e.translationRu}:${e.source}`} e={e} onChanged={load} />)}</tbody>
          </table>
        </div>
      )}
      <p className="muted small">Newest first.</p>
    </div>
  );
}
