import { firstTranslation } from "../format";
import { drawBackground, drawMeteor, makeBackground, makeMeteorVisual, rgba, type MeteorVisual } from "./art";
import { handleDrillKey, LINE_UNITS, tickDrills, type DrillsConfig, type DrillsEngineState, type DrillsEvent } from "./drillsEngine";

/**
 * Canvas renderer for Finger Drills: words stand in lines like a page, each over a meteor of the same size; a typed word explodes with
 * its meteor and leaves the page. It drives the pure engine and never changes game rules; the scene clock stands still while paused.
 */

const VISIBLE_LINES = 4;
const METEOR_R = 30;
const MARGIN_X = 28;
const COLOR_TYPED = "#4be3a0";
const COLOR_TYPED_SLIPPED = "#ff9b8a";
const COLOR_REST = "#f2f5ff";
const COLOR_UPCOMING = "rgba(242,245,255,0.82)";
const ACCENT = "#6ab7ff";
const SHAKE_MS = 380;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  age: number;
  size: number;
  color: string;
}

export interface DrillsSceneOptions {
  config: DrillsConfig;
  engine: DrillsEngineState;
  level: number;
  onEvents: (events: DrillsEvent[]) => void;
  paused: () => boolean;
}

export class DrillsScene {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private opts: DrillsSceneOptions;
  private bg = makeBackground(11);
  private visuals = new Map<number, MeteorVisual>();
  private raf = 0;
  private last = 0;
  private running = false;
  private dpr = 1;
  private clock = 0;
  private particles: Particle[] = [];
  private seenErrorSeq = 0;
  private shakeStart = -Infinity;
  private flashStart = -Infinity;
  /** first visible line, eased towards its target so the page scrolls smoothly */
  private scroll = 0;

  constructor(canvas: HTMLCanvasElement, opts: DrillsSceneOptions) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.opts = opts;
    for (const w of opts.engine.plan) this.visuals.set(w.planIndex, makeMeteorVisual(w.planIndex, opts.level, false));
    this.resize();
  }

  start(): void {
    this.running = true;
    this.last = performance.now();
    const loop = (t: number) => {
      if (!this.running) return;
      const dt = Math.min(100, t - this.last);
      this.last = t;
      if (!this.opts.paused()) {
        this.clock += dt;
        tickDrills(this.opts.engine, dt);
        this.stepFx(dt);
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

  key(k: string): void {
    if (this.opts.paused()) return;
    const events = handleDrillKey(this.opts.engine, k, performance.now());
    for (const e of events) {
      if (e.type === "done") {
        const p = this.wordPos(e.word.planIndex);
        const v = this.visuals.get(e.word.planIndex);
        if (p && v) this.burst(p.x, p.y, [v.palette.light, v.palette.glow, "#ffffff"], 22);
      }
    }
    if (events.length) this.opts.onEvents(events);
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * this.dpr));
  }

  private w(): number {
    return this.canvas.width / this.dpr;
  }
  private h(): number {
    return this.canvas.height / this.dpr;
  }
  /** one layout unit = one letter cell */
  private unitW(): number {
    return (this.w() - MARGIN_X * 2) / LINE_UNITS;
  }
  private lineH(): number {
    return (this.h() - 20) / VISIBLE_LINES;
  }
  private lineY(line: number): number {
    return 10 + (line - this.scroll) * this.lineH() + this.lineH() * 0.42;
  }
  private fontPx(): number {
    return Math.max(14, Math.min(30, this.unitW() * 1.4));
  }

  /** the centre of a word's meteor */
  private wordPos(index: number): { x: number; y: number } | null {
    const e = this.opts.engine;
    const line = e.lineOf[index];
    if (line === undefined) return null;
    const lw = e.lines[line]!.words.find((x) => x.index === index)!;
    return { x: MARGIN_X + (lw.unitStart + e.words[index]!.lemma.length / 2) * this.unitW(), y: this.lineY(line) };
  }

  /** where a word's first letter cell starts */
  private wordX(index: number): number {
    const e = this.opts.engine;
    const lw = e.lines[e.lineOf[index]!]!.words.find((x) => x.index === index)!;
    return MARGIN_X + lw.unitStart * this.unitW();
  }

  /** letters one per cell, evenly spaced */
  private letters(text: string, x0: number, cell: number, baseline: number): void {
    const ctx = this.ctx;
    ctx.textAlign = "center";
    for (let i = 0; i < text.length; i++) ctx.fillText(text[i]!, x0 + (i + 0.5) * cell, baseline);
    ctx.textAlign = "left";
  }

  private font(): string {
    return `700 ${Math.round(this.fontPx())}px ui-monospace, "Cascadia Mono", Consolas, monospace`;
  }

  private burst(x: number, y: number, colors: string[], count: number): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 0.04 + Math.random() * 0.2;
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 400 + Math.random() * 400, age: 0, size: 1.5 + Math.random() * 3, color: colors[i % colors.length]! });
    }
  }

  private stepFx(dt: number): void {
    for (const p of this.particles) {
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.985;
      p.vy *= 0.985;
    }
    this.particles = this.particles.filter((p) => p.age < p.life);
    const e = this.opts.engine;
    if (e.errorSeq !== this.seenErrorSeq) {
      this.seenErrorSeq = e.errorSeq;
      this.shakeStart = this.clock;
      this.flashStart = this.clock;
    }
    const target = Math.max(0, e.line - 1);
    this.scroll += (target - this.scroll) * (1 - Math.exp(-dt / 120));
  }

  private draw(): void {
    const ctx = this.ctx;
    const e = this.opts.engine;
    const w = this.w();
    const h = this.h();
    const t = this.clock / 1000;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    drawBackground(ctx, this.bg, w, h, t);

    const first = Math.max(0, Math.floor(this.scroll));
    const lastLine = Math.min(e.lines.length - 1, first + VISIBLE_LINES);
    const charW = this.unitW();
    const fontPx = this.fontPx();
    const shakeAge = this.clock - this.shakeStart;
    const shake = shakeAge >= 0 && shakeAge < SHAKE_MS ? Math.sin(shakeAge * 0.11) * 7 * (1 - shakeAge / SHAKE_MS) : 0;

    // meteors first, then every label on top
    for (let li = first; li <= lastLine; li++) {
      const dim = li < e.line ? 0.35 : 1;
      for (const lw of e.lines[li]!.words) {
        const word = e.words[lw.index]!;
        if (word.done) continue;
        const p = this.wordPos(lw.index)!;
        const v = this.visuals.get(lw.index)!;
        v.rotation += v.spin;
        ctx.globalAlpha = dim;
        drawMeteor(ctx, v, p.x, p.y, METEOR_R, 0, t, lw.index === e.current, e.plan[lw.index]?.source === "vocabulary" ? "#ffc83d" : undefined);
        ctx.globalAlpha = 1;
      }
    }
    for (let li = first; li <= lastLine; li++) {
      for (const lw of e.lines[li]!.words) {
        const word = e.words[lw.index]!;
        if (word.done) continue; // gone with its meteor, translation included
        const plan = e.plan[lw.index]!;
        const p = this.wordPos(lw.index)!;
        const active = lw.index === e.current;
        const x0 = this.wordX(lw.index) + (active ? shake : 0);
        const baseline = p.y + fontPx * 0.35;
        ctx.font = this.font();
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        {
          ctx.fillStyle = active ? "rgba(10,20,50,0.88)" : "rgba(5,8,25,0.62)";
          ctx.beginPath();
          ctx.roundRect(x0 - 8, p.y - fontPx * 0.72, word.lemma.length * charW + 16, fontPx * 1.4, 8);
          ctx.fill();
          if (active) {
            ctx.strokeStyle = ACCENT;
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }
        if (active) {
          const typed = word.lemma.slice(0, word.progress);
          ctx.fillStyle = word.mistakes > 0 ? COLOR_TYPED_SLIPPED : COLOR_TYPED;
          this.letters(typed, x0, charW, baseline);
          ctx.fillStyle = COLOR_REST;
          this.letters(word.lemma.slice(word.progress), x0 + typed.length * charW, charW, baseline);
          // the key to press next is underlined; after the last letter a small bar asks for the space
          const ux = x0 + word.progress * charW;
          ctx.fillStyle = ACCENT;
          if (word.progress < word.lemma.length) ctx.fillRect(ux, baseline + 5, charW, 3);
          else ctx.fillRect(ux + charW * 0.25, baseline + 5, charW * 1.1, 3);
        } else {
          ctx.fillStyle = COLOR_UPCOMING;
          this.letters(word.lemma, x0, charW, baseline);
        }
        const translation = plan.showTranslation || word.revealed ? firstTranslation(plan.translationRu) : "";
        if (translation) {
          const small = Math.max(11, Math.round(fontPx * 0.5));
          ctx.font = `italic 500 ${small}px system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.fillStyle = "rgba(190,215,255,0.78)";
          ctx.fillText(translation, p.x, p.y + METEOR_R + small + 4);
          ctx.textAlign = "left";
        }
      }
    }

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const p of this.particles) {
      const k = 1 - p.age / p.life;
      ctx.fillStyle = rgba(p.color, Math.max(0, k));
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * k + 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // a wrong key costs a life: the screen edge flashes red, stronger when few are left
    const flashAge = this.clock - this.flashStart;
    if (flashAge >= 0 && flashAge < 400) {
      ctx.strokeStyle = `rgba(255,70,50,${(e.lives <= 3 ? 0.85 : 0.4) * (1 - flashAge / 400)})`;
      ctx.lineWidth = 10;
      ctx.strokeRect(5, 5, w - 10, h - 10);
    }
  }
}
