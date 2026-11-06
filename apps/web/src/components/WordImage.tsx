import { useEffect, useRef, useState } from "react";

/** whether a picture exists, asked once per word or exercise (a missing picture then costs no failed image request) */
const known = new Map<string, Promise<boolean>>();
function hasImage(kind: "slot" | "word", key: string): Promise<boolean> {
  const id = `${kind}:${key}`;
  let p = known.get(id);
  if (!p) {
    const url = kind === "slot" ? `/api/v1/vocabulary-slot-image-exists/${encodeURIComponent(key)}` : `/api/v1/vocabulary-image-exists/${encodeURIComponent(key)}`;
    p = fetch(url)
      .then((r) => (r.ok ? (r.json() as Promise<{ exists?: boolean }>) : { exists: false }))
      .then((j) => j.exists === true)
      .catch(() => false);
    known.set(id, p);
  }
  return p;
}

export function WordImage({ word, slotId, hideIfMissing = false }: { word?: string; slotId?: string; hideIfMissing?: boolean }) {
  const [state, setState] = useState<"checking" | "yes" | "no">("checking");
  const dialog = useRef<HTMLDialogElement>(null);
  const kind = slotId ? "slot" : "word";
  const key = slotId ?? word ?? "";
  useEffect(() => {
    let off = false;
    setState("checking");
    // an exercise picture only exists after the answer was revealed, so that answer is never cached as "no"
    void hasImage(kind, key).then((yes) => { if (!off) setState(yes ? "yes" : "no"); if (!yes && kind === "slot") known.delete(`${kind}:${key}`); });
    return () => { off = true; };
  }, [kind, key]);
  const src = slotId ? `/api/v1/vocabulary-slot-image/${encodeURIComponent(slotId)}` : `/api/v1/vocabulary-image/${encodeURIComponent(word ?? "")}`;
  const label = word ?? "vocabulary exercise";
  if (hideIfMissing && state !== "yes") return null;
  if (state === "checking") return <span className="word-image-placeholder" aria-hidden="true" />;
  if (state === "no") return <span className="word-image-placeholder" aria-label={`No image for ${label}`} title="No image available"><i className="pi pi-image" aria-hidden="true" /></span>;
  return <>
    <button type="button" className="word-image-button" onClick={() => dialog.current?.showModal()} aria-label={`Enlarge image for ${label}`}>
      <img src={src} alt="" onError={() => setState("no")} />
    </button>
    <dialog ref={dialog} className="word-image-dialog" onClick={(e) => { if (e.target === e.currentTarget) e.currentTarget.close(); }}>
      <button type="button" className="btn" onClick={() => dialog.current?.close()} aria-label="Close image"><i className="pi pi-times" aria-hidden="true" /></button>
      <img src={src} alt={label} />
    </dialog>
  </>;
}
