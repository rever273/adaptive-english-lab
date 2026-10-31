import { useEffect, useRef, useState } from "react";

export function WordImage({ word }: { word: string }) {
  const [missing, setMissing] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => setMissing(false), [word]);
  const src = `/api/v1/vocabulary-image/${encodeURIComponent(word)}`;
  if (missing) return <span className="word-image-placeholder" aria-label={`No image for ${word}`} title="No image available"><i className="pi pi-image" aria-hidden="true" /></span>;
  return <>
    <button type="button" className="word-image-button" onClick={() => dialog.current?.showModal()} aria-label={`Enlarge image for ${word}`}>
      <img src={src} alt="" onError={() => setMissing(true)} />
    </button>
    <dialog ref={dialog} className="word-image-dialog" onClick={(e) => { if (e.target === e.currentTarget) e.currentTarget.close(); }}>
      <button type="button" className="btn" onClick={() => dialog.current?.close()} aria-label="Close image">?</button>
      <img src={src} alt={word} />
    </dialog>
  </>;
}
