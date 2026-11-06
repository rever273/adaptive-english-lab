import { useEffect, useRef, useState } from "react";
import { fetchBookSpeech } from "../api";

/** Only complete, short English sentences; never gaps or a reading passage. */
export function isSpeakableSentence(text: string): boolean {
  const t = text.trim();
  return t.length <= 350 && !/[\u0400-\u04ff_\[\]{}]|\.{3}|\u2026/.test(t) && /[.!?]["\u201d\u2019']?$/.test(t) && (t.match(/[A-Za-z]+/g)?.length ?? 0) >= 2 && (t.match(/[.!?](?:\s|$)/g)?.length ?? 0) <= 1;
}
let current: HTMLAudioElement | null = null;
export function SpeakButton({ text }: { text: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = useRef<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (url.current) { if (current?.src === url.current) current.pause(); URL.revokeObjectURL(url.current); url.current = null; } }; }, [text]);
  return <span className="speech-control"><button type="button" className="speech-button" aria-label="Listen to sentence" title="Listen to sentence" disabled={busy} onClick={async (e) => {
    e.preventDefault(); e.stopPropagation(); setBusy(true); setError(null);
    try {
      if (!url.current) { const blob = await fetchBookSpeech({ text }); if (!alive.current) return; url.current = URL.createObjectURL(blob); }
      current?.pause(); current = new Audio(url.current); await current.play();
    } catch (err) { if (alive.current) setError(err instanceof Error ? err.message : "Could not play speech."); } finally { if (alive.current) setBusy(false); }
  }}><i className={`pi ${busy ? "pi-spin pi-spinner" : "pi-volume-up"}`} aria-hidden="true" /></button>{error && <span role="alert" className="small">{error}</span>}</span>;
}
