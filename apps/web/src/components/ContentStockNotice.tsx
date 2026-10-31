import { useEffect, useState } from "react";
import { fetchContentStock } from "../api";

export function ContentStockNotice({ onOpen }: { onOpen: (category: "grammar" | "vocabulary") => void }) {
  const [stock, setStock] = useState<Awaited<ReturnType<typeof fetchContentStock>> | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  useEffect(() => {
    const load = async () => { try { setStock(await fetchContentStock()); } catch { /* Keep the previous stock; connection errors have their own UI. */ } };
    void load(); const t = setInterval(() => void load(), 15000); return () => clearInterval(t);
  }, []);
  useEffect(() => {
    // Re-arm after replenishment; a later stock warning must not be hidden forever.
    if (stock) setDismissed(prev => new Set([...prev].filter(c => stock[c as "grammar" | "vocabulary"].low)));
  }, [stock]);
  const category = (["grammar", "vocabulary"] as const).find(c => stock?.[c].low && !dismissed.has(c));
  if (!category || !stock) return null;
  return <aside className="content-stock-notice notice notice-error" role="status" aria-label="Exercise stock running low">
    <strong>More {category} exercises needed</strong>
    <p className="small">{stock[category].available} new approved exercises remain. Create a new batch in Content Studio.</p>
    <div className="actions"><button className="btn btn-primary" onClick={() => {onOpen(category); setDismissed(p => new Set([...p,category]));}}>Open Content Studio</button><button className="link" onClick={() => setDismissed(p => new Set([...p,category]))}>Dismiss</button></div>
  </aside>;
}
