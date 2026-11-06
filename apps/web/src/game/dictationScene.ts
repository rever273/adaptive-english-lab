import { drawBackground, drawMeteor, drawShip, makeBackground, makeMeteorVisual, type MeteorVisual } from "./art";
import { Effects } from "./fx";

/**
 * Canvas 2D scene of Audio Dictation (D93): every sentence is a numbered meteor in a fixed cell of a grid (a small offset and a slow bob make it
 * look scattered); the active one pulses and shows a speaker. No text. The ship aims at the active meteor and fires when the answer is right.
 * It only reads what the page gives it and never changes the game rules.
 */
export interface DictationSceneState {
  total: number;
  /** index of the active meteor, null when the lesson is complete */
  active: number | null;
  /** meteors already destroyed */
  done: ReadonlySet<number>;
  playing: boolean;
}

const MIN_R = 14;
const BOLT_MS = 150;
const ACCENT = "#6ab7ff";

export class DictationScene {
  private ctx: CanvasRenderingContext2D;
  private bg = makeBackground(33);
  private visuals = new Map<number, MeteorVisual>();
  private fx = new Effects();
  private raf = 0;
  private last = 0;
  private running = false;
  private dpr = 1;
  private clock = 0;
  private angle = 0;
  private bolt: { index: number; age: number } | null = null;
  private reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(
    private canvas: HTMLCanvasElement,
    private read: () => DictationSceneState,
    private level: number,
  ) {
    this.ctx = canvas.getContext("2d")!;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.resize();
    const loop = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(now - this.last, 100);
      this.last = now;
      this.step(dt);
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
  }

  /** the answer was right: a bolt and an explosion at that meteor */
  destroy(index: number): void {
    this.bolt = { index, age: 0 };
  }

  private visual(i: number): MeteorVisual {
    let v = this.visuals.get(i);
    if (!v) {
      v = makeMeteorVisual(i, this.level, false);
      this.visuals.set(i, v);
    }
    return v;
  }

  private cells(w: number, h: number, n: number): { x: number; y: number; r: number } | null {
    const shipRoom = 70;
    const field = h - shipRoom;
    let best = { cols: 1, r: 0 };
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const r = Math.min(w / cols, field / rows) / 2;
      if (r > best.r) best = { cols, r };
    }
    return best.r < MIN_R ? null : { x: best.cols, y: Math.ceil(n / best.cols), r: best.r };
  }

  private spot(i: number, w: number, h: number, g: { x: number; y: number; r: number }): { x: number; y: number; r: number } {
    const cw = w / g.x;
    const ch = (h - 70) / g.y;
    const col = i % g.x;
    const row = Math.floor(i / g.x);
    const jx = Math.sin(i * 12.9898) * g.r * 0.12;
    const jy = Math.cos(i * 78.233) * g.r * 0.12;
    const bob = this.reduced ? 0 : Math.sin(this.clock / 900 + i) * g.r * 0.05;
    return { x: cw * (col + 0.5) + jx, y: ch * (row + 0.5) + jy + bob, r: g.r * 0.78 };
  }

  private step(dt: number): void {
    this.clock += dt;
    this.fx.step(dt);
    const s = this.read();
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const g = this.cells(w, h, s.total);
    if (g && s.active !== null) {
      const p = this.spot(s.active, w, h, g);
      const target = Math.atan2(p.y - (h - 30), p.x - w / 2) + Math.PI / 2;
      this.angle += (target - this.angle) * Math.min(1, dt / 160);
    }
    if (this.bolt) {
      this.bolt.age += dt;
      if (this.bolt.age >= BOLT_MS) {
        if (g) {
          const p = this.spot(this.bolt.index, w, h, g);
          this.fx.explode(p.x, p.y, p.r, [this.visual(this.bolt.index).palette.glow, "#ffffff", ACCENT], this.reduced ? 10 : 28);
        }
        this.bolt = null;
      }
    }
  }

  private draw(): void {
    const { ctx, dpr } = this;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const s = this.read();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const t = this.clock / 1000; // art.ts animates in seconds
    drawBackground(ctx, this.bg, w, h, t);
    const g = this.cells(w, h, s.total);
    if (!g) {
      ctx.fillStyle = "#fff";
      ctx.font = "15px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("The window is too small for this lesson. Make it larger.", w / 2, h / 2);
      return;
    }
    for (let i = 0; i < s.total; i++) {
      const exploding = this.bolt?.index === i;
      if (s.done.has(i) && !exploding) continue;
      const p = this.spot(i, w, h, g);
      const isActive = s.active === i;
      const pulse = isActive && !this.reduced ? 1 + Math.sin(this.clock / 700) * 0.03 : 1;
      drawMeteor(ctx, this.visual(i), p.x, p.y, p.r * pulse, 0, t, isActive, isActive ? ACCENT : undefined);
      ctx.fillStyle = "#fff";
      ctx.font = `bold ${Math.max(12, Math.round(p.r * 0.7))}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), p.x, p.y);
      if (isActive) this.speaker(p.x, p.y - p.r - 10, s.playing);
    }
    if (this.bolt) {
      const p = this.spot(this.bolt.index, w, h, g);
      const k = this.bolt.age / BOLT_MS;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(w / 2, h - 40);
      ctx.lineTo(w / 2 + (p.x - w / 2) * k, h - 40 + (p.y - (h - 40)) * k);
      ctx.stroke();
    }
    drawShip(ctx, w / 2, h - 30, this.angle, t, this.bolt ? 1 : 0, 1);
    this.fx.draw(ctx);
  }

  /** a small speaker; it shows waves while the sentence is playing */
  private speaker(x: number, y: number, playing: boolean): void {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 9, y - 3);
    ctx.lineTo(x - 4, y - 3);
    ctx.lineTo(x + 2, y - 8);
    ctx.lineTo(x + 2, y + 8);
    ctx.lineTo(x - 4, y + 3);
    ctx.lineTo(x - 9, y + 3);
    ctx.closePath();
    ctx.fill();
    if (playing) {
      const wave = this.reduced ? 1 : (Math.floor(this.clock / 250) % 2) + 1;
      for (let k = 1; k <= wave + 1; k++) {
        ctx.beginPath();
        ctx.arc(x + 2, y, 4 + k * 4, -0.7, 0.7);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
