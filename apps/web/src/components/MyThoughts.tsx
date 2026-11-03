import { useEffect, useState } from "react";
import * as api from "../api.js";

const STATUS: Record<api.ThoughtItem["status"], string> = {
  pending: "Saved, waiting to be read",
  needs_skills: "Read, waiting for a grammar check",
  ok: "Ready to become practice",
  ambiguous: "Not clear enough to use",
  no_skill: "No matching grammar skill",
  failed: "Could not be processed",
};

/** One text box for a thought in Russian. Saving is a single action; the thoughts become ordinary exercises later, through the normal review. */
export function MyThoughts() {
  const [text, setText] = useState("");
  const [items, setItems] = useState<api.ThoughtItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.fetchThoughts().then((r) => setItems(r.thoughts)).catch(() => undefined);
  useEffect(() => void load(), []);

  const save = async () => {
    if (busy || text.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.addThought(text);
      setText("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the thought.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card my-thoughts" aria-labelledby="thoughts-h" data-testid="my-thoughts">
      <h3 id="thoughts-h"><i className="pi pi-comment" aria-hidden="true" /> My Thoughts</h3>
      <p className="small">Write something you would like to say, in Russian. It is saved and later turned into practice with natural English patterns; it does not change what you are shown next.</p>
      <label className="visually-hidden" htmlFor="thought-text">A thought in Russian</label>
      <textarea id="thought-text" rows={2} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} placeholder="Вот было бы здорово завтра пойти покататься на коньках." />
      <div className="actions">
        <button className="btn btn-primary" disabled={busy || text.trim().length === 0} onClick={() => void save()}>
          <i className="pi pi-send" aria-hidden="true" /> Save thought
        </button>
      </div>
      {error && <p className="notice notice-error small" role="alert">{error}</p>}
      {items.length > 0 && (
        <ul className="small thought-list">
          {items.slice(0, 5).map((t) => (
            <li key={t.id}>
              {t.textRu} <span className="muted">— {STATUS[t.status]}</span>
              {t.englishDraft && <> <em>{t.englishDraft}</em> <span className="badge badge-info">AI draft, not checked</span></>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
