import { drawMeteor, drawShip, makeBackground, makeMeteorVisual, type MeteorVisual } from "./art";
import { handleWordKey, tickWords, type WordsEngineState, type WordsEngineConfig, type WordsEvent } from "./wordsEngine";

/**
 * Canvas 2D renderer for the Words game. Owns the requestAnimationFrame loop, drives the pure engine, assigns lanes to newly
 * spawned meteors and draws a dark space scene. It never mutates game rules; graphics use their own seeded random.
 */

const clampDt = (dt: number): number => Math.min(dt, 100);

export interface WordsSceneOptions {
  config: WordsEngineConfig;
  engine: WordsEngineState;
  onEvents: (events: WordsEvent[]) => void;
  level: number;
  lanes: number;
  paused: () => boolean;
}

export class WordsScene {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private engine: WordsEngineState;
  private config: WordsEngineConfig;
  private onEvents: (events: WordsEvent[]) => void;
  private level: number;
  private lanes: number;
  private paused: () => boolean;
  private bg = makeBackground(7);
  private visuals = new Map<number, MeteorVisual>();
  private raf = 0;
  private last = 0;
  private running = false;
  private destroyedFx = new Map<number, number>();
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement, opts: WordsSceneOptions) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.engine = opts.engine;
    this.config = opts.config;
    this.onEvents = opts.onEvents;
    this.level = opts.level;
    this.lanes = opts.lanes;
    this.paused = opts.paused;
    for (const w of opts.engine.plan) this.visuals.set(w.planIndex, makeMeteorVisual(w.planIndex, this.level, w.lemma.length > 9));
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
        const { events } = tickWords(this.engine, this.config, dt);
        if (events.length) this.onEvents(events);
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

  key(k: string): WordsEvent[] {
    if (this.paused()) return [];
    return handleWordKey(this.engine, this.config, k);
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

  private assignLanes(): void {
    for (const word of this.engine.words) {
      if (word.lane > 0) continue;
      const counts = new Array(this.lanes).fill(0) as number[];
      for (const w2 of this.engine.words) {
        if (w2.destroying || w2 === word || w2.lane === 0) continue;
        counts[(w2.lane - 1) % this.lanes]! += 1;
      }
      let best = 0;
      for (let i = 1; i < this.lanes; i++) if (counts[i]! < counts[best]!) best = i;
      word.lane = best + 1;
    }
  }

  private draw(): void {
    this.assignLanes();
    const ctx = this.ctx;
    const w = this.w();
    const h = this.h();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#0b0e1a";
    ctx.fillRect(0, 0, w, h);
    const t = performance.now() / 1000;
    for (const s of this.bg.stars) {
      const y = (s.y * h + t * 8 * s.layer) % h;
      ctx.fillStyle = `rgba(255,255,255,${0.3 + s.layer * 0.5})`;
      ctx.beginPath();
      ctx.arc(s.x * w, y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(this.bg.planet.x * w, this.bg.planet.y * h, this.bg.planet.r, 0, Math.PI * 2);
    ctx.fillStyle = this.bg.planet.color;
    ctx.globalAlpha = 0.5;
    ctx.fill();
    ctx.globalAlpha = 1;

    const lineY = h - 90;
    ctx.strokeStyle = "rgba(120,180,255,0.6)";
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(0, lineY);
    ctx.lineTo(w, lineY);
    ctx.stroke();
    ctx.setLineDash([]);

    const laneW = w / this.lanes;
    for (const word of this.engine.words) {
      const age = this.destroyedFx.get(word.planIndex) ?? 0;
      if (word.destroying && age > 420) continue;
      const cx = laneW * (Math.max(1, word.lane) - 0.5);
      const cy = word.y * lineY;
      const radius = Math.max(26, Math.min(46, word.lemma.length * 4.5));
      const visual = this.visuals.get(word.planIndex) ?? makeMeteorVisual(word.planIndex, this.level, word.lemma.length > 9);
      visual.rotation += visual.spin;
      if (word.destroying) {
        this.destroyedFx.set(word.planIndex, age + 16);
        ctx.globalAlpha = Math.max(0, 1 - age / 420);
      }
      const danger = Math.max(0, word.y - 0.5) * 2;
      const baseline = drawMeteor(ctx, visual, cx, cy, radius, danger);
      ctx.globalAlpha = 1;
      ctx.font = "600 15px system-ui";
      ctx.textAlign = "center";
      const tw = ctx.measureText(word.lemma).width;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(cx - tw / 2 - 6, baseline - 16, tw + 12, 20);
      const typed = word.lemma.slice(0, word.progress);
      const errPart = word.errors.join("");
      const rest = word.lemma.slice(word.progress + word.errors.length);
      ctx.fillStyle = word.source === "vocabulary" ? "#ffd76a" : "#ffffff";
      ctx.fillText(typed + errPart + rest, cx, baseline);
      if (word.errors.length) {
        ctx.fillStyle = "#ff5a4a";
        ctx.fillText(errPart, cx, baseline);
      }
    }

    const target = this.engine.target !== null ? this.engine.words[this.engine.target] : undefined;
    const shipX = target && !target.destroying ? laneW * (Math.max(1, target.lane) - 0.5) : w / 2;
    drawShip(ctx, shipX, h - 40, 0);

    if (this.engine.flash > 0) {
      ctx.fillStyle = `rgba(255,60,40,${this.engine.flash / 250})`;
      ctx.fillRect(0, 0, w, h);
    }
  }
}
