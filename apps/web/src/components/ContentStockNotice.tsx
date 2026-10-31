import { useEffect, useState } from "react";
import { fetchContentStock } from "../api";

type Category = "grammar" | "vocabulary";
const SEEN = "stockNoticeSeen";
/** Once per browser session is enough (remembered per category; a reload or a page change must not bring it back). */
const seenBefore = (c: Category): boolean => { try { return sessionStorage.getItem(`${SEEN}:${c}`) === "1"; } catch { return false; } };
const markSeen = (c: Category): void => { try { sessionStorage.setItem(`${SEEN}:${c}`, "1"); } catch { /* storage can be blocked: the notice then simply lives until dismissed */ } };

export function ContentStockNotice({ onOpen }: { onOpen: (category: Category) => void }) {
  const [stock, setStock] = useState<Awaited<ReturnType<typeof fetchContentStock>> | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set((["grammar", "vocabulary"] as const).filter(seenBefore)));
  useEffect(() => {
    const load = async () => { try { setStock(await fetchContentStock()); } catch { /* Keep the previous stock; connection errors have their own UI. */ } };
    void load(); const t = setInterval(() => void load(), 15000); return () => clearInterval(t);
  }, []);
  const category = (["grammar", "vocabulary"] as const).find(c => stock?.[c].low && !dismissed.has(c));
  useEffect(() => { if (category) markSeen(category); }, [category]);
  if (!category || !stock) return null;
  const close = () => setDismissed(p => new Set([...p, category]));
  return <aside className="content-stock-notice notice notice-error" role="status" aria-label="Exercise stock running low">
    <strong>More {category} exercises needed</strong>
    <p className="small">{stock[category].message ?? `${stock[category].available} new approved exercises remain.`} Create a new batch in Content Studio{stock[category].recommended ? ` (suggested size ${stock[category].recommended})` : ""}.</p>
    <div className="actions"><button className="btn btn-primary" onClick={() => { onOpen(category); close(); }}>Open Content Studio</button><button className="link" onClick={close}>Dismiss</button></div>
  </aside>;
}
