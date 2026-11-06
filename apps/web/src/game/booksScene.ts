import { drawBackground, drawMeteor, drawShip, makeBackground, makeMeteorVisual, type MeteorVisual } from "./art";
import { tickBooks, type BookKeyKind, type BooksEngineState } from "./booksEngine";
import { comboTier, nextMilestone } from "./booksEngine";
import { Effects } from "./fx";

/**
 * Canvas 2D scene for the Books mode: every word of the text is a meteor, scattered over the field instead of falling. The
 * meteors of the next few words are on screen; finishing a word destroys its meteor and the following one takes its place.
 * Sizes follow the (height-limited) canvas and the word length. It only reads the engine, it never changes game rules.
 */

/** meteors smaller than this are drawn in a cheaper way, so a whole level (hundreds of words) stays smooth */
const SIMPLE_R = 11;
const BOLT_MS = 130;
const ACCENT = "#6ab7ff";
/** shot and glow colours by combo tier (0: none yet ... 5: 200+ characters) */
const SHOT = [
  { glow: "rgba(90,200,255,0.55)", core: "#ffffff", css: "#6ab7ff", width: 6 },
  { glow: "rgba(90,255,160,0.6)", core: "#eafff3", css: "#5af0a0", width: 6.5 },
  { glow: "rgba(255,215,80,0.65)", core: "#fff7d6", css: "#ffd750", width: 7 },
  { glow: "rgba(255,150,60,0.7)", core: "#fff0dc", css: "#ff963c", width: 7.5 },
  { glow: "rgba(255,90,230,0.72)", core: "#ffe9fb", css: "#ff5ae6", width: 8 },
  { glow: "rgba(170,140,255,0.8)", core: "#ffffff", css: "#aa8cff", width: 9 },
] as const;

const clampDt = (dt: number): number => Math.min(dt, 100);

function seeded(n: number): () => number {
  let a = (n + 1) * 0x9e3779b1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Spot {
  x: number;
  y: number;
  r: number;
}

interface Bolt {
  index: number;
  x0: number;
  y0: number;
  age: number;
  final: boolean;
}

export class BooksScene {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private engine: BooksEngineState;
  private level: number;
  private paused: () => boolean;
  private bg = makeBackground(21);
  private visuals = new Map<number, MeteorVisual>();
  private fx = new Effects();
  private bolts: Bolt[] = [];
  private seenMilestone = 0;
  private milestoneAt = -10_000;
  private exploded = new Set<number>();
  private raf = 0;
  private last = 0;
  private running = false;
  private dpr = 1;
  private clock = 0;
  private active = 0;
  private shipAngle = 0;
  private muzzle = 0;
  private aimUntil = 0;
  /** the word the ship last shot at: it keeps pointing there, then returns to the centre */
  private aimIndex = 0;
  private spots: Spot[] = [];
  private spotsFor = "";

  constructor(canvas: HTMLCanvasElement, opts: { engine: BooksEngineState; level: number; paused: () => boolean }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.engine = opts.engine;
    this.level = opts.level;
    this.paused = opts.paused;
    this.resize();
  }

  start(): void {
    this.running = true;
    this.last = performance.now();
    const loop = (t: number) => {
      if (!this.running) return;
      const dt = clampDt(t - this.last);
      this.last = t;
      if (!this.paused()) {
        this.clock += dt;
        this.step(dt);
      }
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
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * this.dpr));
  }

  /** called by the host after each handled key: a correct letter is a shot at the word it belongs to */
  keyResult(kind: BookKeyKind, typedOffset: number): { shot: boolean; wordDone: boolean } {
    const none = { shot: false, wordDone: false };
    if (kind !== "ok" && kind !== "capital") return none;
    const tokens = this.engine.tokens;
    const index = tokens.findIndex((t) => typedOffset >= t.startOffset && typedOffset < t.endOffset);
    if (index < 0) return none; // a space between words: nothing to shoot
    const tok = tokens[index]!;
    const final = tok.keys[tok.keys.length - 1]!.offset === typedOffset;
    const ship = this.shipPos();
    const p = this.place(index);
    const angle = Math.atan2(p.x - ship.x, ship.y - p.y);
    this.aimUntil = this.clock + 450;
    this.aimIndex = index;
    this.shipAngle += (this.clampAngle(angle) - this.shipAngle) * 0.6;
    this.muzzle = 1;
    this.bolts.push({ index, x0: ship.x + Math.sin(this.shipAngle) * 26, y0: ship.y - Math.cos(this.shipAngle) * 26, age: 0, final });
    return { shot: true, wordDone: final };
  }

  private w(): number {
    return this.canvas.width / this.dpr;
  }
  private h(): number {
    return this.canvas.height / this.dpr;
  }
  private shipPos(): { x: number; y: number } {
    return { x: this.w() / 2, y: this.h() - 24 };
  }
  private clampAngle(a: number): number {
    return Math.max(-1.3, Math.min(1.3, a));
  }

  /** index of the first word that is not finished yet */
  private findActive(): number {
    const e = this.engine;
    if (e.finished) return e.tokens.length;
    let i = Math.min(this.active, e.tokens.length);
    while (i > 0 && e.tokens[i - 1]!.keys[e.tokens[i - 1]!.keys.length - 1]!.offset >= e.offset) i--;
    while (i < e.tokens.length && e.tokens[i]!.keys[e.tokens[i]!.keys.length - 1]!.offset < e.offset) i++;
    return i;
  }

  private visualOf(i: number): MeteorVisual {
    let v = this.visuals.get(i);
    if (!v) {
      v = makeMeteorVisual(i + 3, Math.max(7, this.level), (this.engine.tokens[i]?.keys.length ?? 0) > 9);
      this.visuals.set(i, v);
    }
    return v;
  }

  private shipZone(): number {
    return Math.max(40, Math.min(70, this.h() * 0.14));
  }

  /**
   * Every word of the level gets its own meteor from the start, at a random place. Meteors are dropped one after another at random
   * positions, biggest first, and rejected when they would touch another one; if the whole level does not fit, every size shrinks a
   * little and the placement is repeated, so the field is as full as it can be and nothing overlaps. A longer word is a bigger meteor.
   */
  private layout(): void {
    const w = this.w();
    const h = this.h();
    const n = this.engine.tokens.length;
    const key = `${Math.round(w)}x${Math.round(h)}:${n}`;
    if (key === this.spotsFor) return;
    this.spotsFor = key;
    const top = 6;
    const areaH = Math.max(40, h - this.shipZone() - top);
    const weights = this.engine.tokens.map((t) => 0.6 + 0.04 * Math.min(t.keys.length, 10));
    // start from the size a perfect packing of equal circles would allow, and shrink until the random placement succeeds
    let scale = Math.sqrt((w * areaH * 0.78) / (Math.max(1, n) * Math.PI * 0.45));
    const order = weights.map((_, i) => i).sort((x, y) => weights[y]! - weights[x]!);
    const gap = 3;
    let spots: Spot[] = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      const rnd = seeded(n * 31 + attempt);
      const placed: Array<Spot | undefined> = new Array(n).fill(undefined);
      const list: Spot[] = [];
      let ok = true;
      for (const i of order) {
        const r = Math.max(2.5, scale * weights[i]!);
        let spot: Spot | undefined;
        for (let tries = 0; tries < 40 && !spot; tries++) {
          const x = r + 2 + rnd() * Math.max(0, w - 2 * r - 4);
          const y = top + r + rnd() * Math.max(0, areaH - 2 * r);
          if (list.every((o) => (o.x - x) ** 2 + (o.y - y) ** 2 >= (o.r + r + gap) ** 2)) spot = { x, y, r };
        }
        if (!spot) {
          ok = false;
          break;
        }
        placed[i] = spot;
        list.push(spot);
      }
      if (ok) {
        spots = placed as Spot[];
        break;
      }
      scale *= 0.94;
    }
    this.spots = spots.length === n ? spots : this.engine.tokens.map((_, i) => ({ x: ((i % 20) + 0.5) * (w / 20), y: top + (Math.floor(i / 20) + 0.5) * 8, r: 2.5 }));
  }

  private place(i: number): Spot {
    this.layout();
    return this.spots[i] ?? { x: this.w() / 2, y: this.h() / 2, r: 6 };
  }

  private step(dt: number): void {
    // active time is the sum of the gaps between keys; without this clock it stays at zero
    tickBooks(this.engine, dt);
    this.active = this.findActive();
    for (const i of [...this.exploded]) if (i >= this.active) this.exploded.delete(i);
    for (const b of this.bolts) b.age += dt;
    const landed = this.bolts.filter((b) => b.age >= BOLT_MS);
    this.bolts = this.bolts.filter((b) => b.age < BOLT_MS);
    for (const b of landed) {
      const p = this.place(b.index);
      const v = this.visualOf(b.index);
      if (b.final && b.index < this.active) {
        this.exploded.add(b.index);
        this.fx.explode(p.x, p.y, p.r * 1.5, [v.palette.light, v.palette.glow, "#ffffff"], 28);
      } else {
        this.fx.explode(p.x, p.y + p.r * 0.2, p.r * 0.3, [v.palette.light, v.palette.glow, "#ffffff"], 4);
      }
    }
    this.fx.step(dt);
    this.muzzle = Math.max(0, this.muzzle - dt / 120);
    const target = this.aimUntil > this.clock ? this.aimAngle() : 0;
    this.shipAngle += (target - this.shipAngle) * (1 - Math.exp(-dt / 70));
  }

  private aimAngle(): number {
    const ship = this.shipPos();
    const p = this.place(this.aimIndex);
    return this.clampAngle(Math.atan2(p.x - ship.x, ship.y - p.y));
  }

  private draw(): void {
    const ctx = this.ctx;
    const w = this.w();
    const h = this.h();
    const t = this.clock / 1000;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    drawBackground(ctx, this.bg, w, h, t);
    const e = this.engine;
    const pendingFinal = new Set(this.bolts.filter((b) => b.final).map((b) => b.index));
    this.layout();
    const from = Math.max(0, this.active - 4);
    for (let i = from; i < e.tokens.length; i++) {
      if (this.exploded.has(i)) continue;
      if (i < this.active && !pendingFinal.has(i)) continue;
      const p = this.spots[i]!;
      const v = this.visualOf(i);
      v.rotation += v.spin;
      const isActive = i === this.active;
      if (p.r < SIMPLE_R && !isActive) {
        this.drawSimple(v, p);
      } else {
        drawMeteor(ctx, v, p.x, p.y, p.r, 0, t, isActive);
      }
      if (isActive) this.drawReticle(p.x, p.y, p.r, t, e.errors.length > 0);
    }
    this.drawBolts();
    this.fx.draw(ctx);
    const ship = this.shipPos();
    this.drawCombo(ship, t);
    drawShip(ctx, ship.x, ship.y, this.shipAngle, t, this.muzzle, 0.8);
  }

  /** Precision Combo beside the ship: the run of correct characters, the next milestone, and a glow once a tier is reached */
  private drawCombo(ship: { x: number; y: number }, t: number): void {
    const ctx = this.ctx;
    const e = this.engine;
    const tier = comboTier(e.combo);
    const shot = SHOT[tier]!;
    if (tier > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const g = ctx.createRadialGradient(ship.x, ship.y, 4, ship.x, ship.y, 54);
      g.addColorStop(0, shot.glow);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(ship.x, ship.y, 54, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    // a short flash when a milestone is reached
    if (e.milestoneSeq !== this.seenMilestone) {
      this.seenMilestone = e.milestoneSeq;
      this.milestoneAt = this.clock;
    }
    const flash = Math.max(0, 1 - (this.clock - this.milestoneAt) / 900);
    const x = ship.x + 72;
    const next = nextMilestone(e.combo);
    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.fillStyle = tier > 0 ? shot.css : "rgba(200,215,255,0.8)";
    ctx.shadowColor = shot.glow;
    ctx.shadowBlur = tier > 0 ? 6 + flash * 14 : 0;
    ctx.fillText("Precision Combo", x, ship.y - 22);
    ctx.shadowBlur = 0;
    ctx.font = `bold ${20 + Math.round(flash * 6)}px system-ui, sans-serif`;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(`${e.combo} characters`, x, ship.y + 1);
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillStyle = "rgba(200,215,255,0.75)";
    ctx.fillText(next === null ? "Top tier reached" : `Next milestone: ${next}`, x, ship.y + 19);
    void t;
    ctx.restore();
  }

  /** a small meteor: one gradient for the body and one faint glow, nothing else */
  private drawSimple(v: MeteorVisual, p: Spot): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(v.rotation);
    ctx.fillStyle = v.palette.glow;
    ctx.globalAlpha = 0.16;
    ctx.beginPath();
    ctx.arc(0, 0, p.r * 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    const g = ctx.createRadialGradient(-p.r * 0.35, -p.r * 0.35, p.r * 0.1, 0, 0, p.r);
    g.addColorStop(0, v.palette.light);
    g.addColorStop(0.6, v.palette.base);
    g.addColorStop(1, v.palette.dark);
    ctx.fillStyle = g;
    ctx.beginPath();
    v.points.forEach((pt, k) => {
      const x = Math.cos(pt.a) * p.r * pt.r;
      const y = Math.sin(pt.a) * p.r * pt.r;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawReticle(x: number, y: number, r: number, t: number, bad: boolean): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(t * 1.2);
    ctx.strokeStyle = bad ? "rgba(255,107,94,0.95)" : "rgba(120,200,255,0.9)";
    ctx.lineWidth = 2;
    ctx.setLineDash([9, 7]);
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.35, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    ctx.setLineDash([]);
  }

  private drawBolts(): void {
    const ctx = this.ctx;
    for (const b of this.bolts) {
      const p = this.place(b.index);
      const k = Math.min(1, b.age / BOLT_MS);
      const head = { x: b.x0 + (p.x - b.x0) * k, y: b.y0 + (p.y - b.y0) * k };
      const tk = Math.max(0, k - 0.3);
      const tail = { x: b.x0 + (p.x - b.x0) * tk, y: b.y0 + (p.y - b.y0) * tk };
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";
      const shot = SHOT[comboTier(this.engine.combo)]!;
      ctx.strokeStyle = shot.glow;
      ctx.lineWidth = shot.width;
      ctx.beginPath();
      ctx.moveTo(tail.x, tail.y);
      ctx.lineTo(head.x, head.y);
      ctx.stroke();
      ctx.strokeStyle = shot.core;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
  }
}
