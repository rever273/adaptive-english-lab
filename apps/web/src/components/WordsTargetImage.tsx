import { useEffect, useState } from "react";
import { hasImage } from "./WordImage";

/** A non-interactive illustration for the word currently being typed. */
export function WordsTargetImage({ word, translation }: { word: string | null; translation: string | null }) {
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (word) {
      void hasImage("word", word).then((exists) => {
        if (!exists || cancelled) return;
        const image = new Image();
        image.onload = () => { if (!cancelled) setShown(word); };
        image.src = `/api/v1/vocabulary-image/${encodeURIComponent(word)}`;
      });
    }
    const timer = window.setTimeout(() => setShown((current) => current === word ? current : null), 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [word]);
  return (
    <div className="words-target-image-area" aria-hidden="true">
      {shown && <img className={`words-target-image${shown === word ? " is-visible" : ""}`} src={`/api/v1/vocabulary-image/${encodeURIComponent(shown)}`} alt="" />}
      {word && translation && <div className="words-target-translation">{translation}</div>}
    </div>
  );
}
