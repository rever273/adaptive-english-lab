import { useEffect, useMemo, useRef, useState } from "react";

const COLS = 40, ROWS = 25, TILES = COLS * ROWS; // 1000 zones
const SEEN_KEY = "el_cloze_reveal_seen_v1";

/** a fixed shuffle of the 1000 zones: the same order on every visit, so progress only ever opens more of the picture */
function order(seed: number): number[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const o = Array.from({ length: TILES }, (_, i) => i);
  for (let i = TILES - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [o[i], o[j]] = [o[j]!, o[i]!];
  }
  return o;
}
const readSeen = (): number => { try { return Math.max(0, Number(localStorage.getItem(SEEN_KEY)) || 0); } catch { return 0; } };
const writeSeen = (n: number): void => { try { localStorage.setItem(SEEN_KEY, String(n)); } catch { /* storage unavailable */ } };

/**
 * A picture hidden under black tiles: every 0.1 % of Stage 1 opens one of 1000 zones, in a fixed random order. 100 % shows the whole picture.
 * Zones opened since the last visit fade in once.
 */
export function RevealPicture({ processed, total, src }: { processed: number; total: number; src: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const shuffled = useMemo(() => order(20261108), []);
  const open = total <= 0 ? 0 : processed >= total ? TILES : Math.min(TILES, Math.floor((processed / total) * TILES));
  useEffect(() => {
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = src;
  }, [src]);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !img) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const W = 1200, H = Math.round((W * img.naturalHeight) / img.naturalWidth);
    c.width = W;
    c.height = H;
    const tw = W / COLS, th = H / ROWS;
    const isOpen = new Set(shuffled.slice(0, open));
    const before = Math.min(readSeen(), open);
    const fresh = shuffled.slice(before, open);
    const draw = (alpha: number) => {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      if (open >= TILES) { ctx.drawImage(img, 0, 0, W, H); return; }
      const fading = new Set(fresh);
      for (const t of isOpen) {
        const x = (t % COLS) * tw, y = Math.floor(t / COLS) * th;
        ctx.globalAlpha = fading.has(t) ? alpha : 1;
        // a hair wider than the cell, so no seam shows between open neighbours
        ctx.drawImage(img, (x / W) * img.naturalWidth, (y / H) * img.naturalHeight, (tw / W) * img.naturalWidth, (th / H) * img.naturalHeight, x - 0.5, y - 0.5, tw + 1, th + 1);
      }
      ctx.globalAlpha = 1;
    };
    if (fresh.length === 0) { draw(1); writeSeen(open); return; }
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / 1400);
      draw(k);
      if (k < 1) raf = requestAnimationFrame(step);
      else writeSeen(open);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [img, open, shuffled]);
  return (
    <figure className="gc-reveal" data-testid="cloze-reveal">
      <canvas ref={canvas} className="gc-reveal-canvas" role="img" aria-label={`A hidden picture: ${open} of ${TILES} pieces are open`} />
      <figcaption className="muted small">{open >= TILES ? "The whole picture is open. Stage 1 is complete." : `${open} of ${TILES} pieces open. Every 0.1 % of Stage 1 opens one more.`}</figcaption>
    </figure>
  );
}
