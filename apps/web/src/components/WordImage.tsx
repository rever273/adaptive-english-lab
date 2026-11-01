import { useEffect, useRef, useState } from "react";

export function WordImage({ word, slotId }: { word?: string; slotId?: string }) {
  const [missing, setMissing] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => setMissing(false), [word, slotId]);
  const src = slotId ? `/api/v1/vocabulary-slot-image/${encodeURIComponent(slotId)}` : `/api/v1/vocabulary-image/${encodeURIComponent(word ?? "")}`;
  const label = word ?? "vocabulary exercise";
  if (missing) return <span className="word-image-placeholder" aria-label={`No image for ${label}`} title="No image available"><i className="pi pi-image" aria-hidden="true" /></span>;
  return <>
    <button type="button" className="word-image-button" onClick={() => dialog.current?.showModal()} aria-label={`Enlarge image for ${label}`}>
      <img src={src} alt="" onError={() => setMissing(true)} />
    </button>
    <dialog ref={dialog} className="word-image-dialog" onClick={(e) => { if (e.target === e.currentTarget) e.currentTarget.close(); }}>
      <button type="button" className="btn" onClick={() => dialog.current?.close()} aria-label="Close image"><i className="pi pi-times" aria-hidden="true" /></button>
      <img src={src} alt={label} />
    </dialog>
  </>;
}
