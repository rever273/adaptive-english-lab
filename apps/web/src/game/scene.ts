import { firstTranslation } from "../format";
import { drawBackground, drawMeteor, drawShip, makeBackground, makeMeteorVisual, rgba, type MeteorVisual } from "./art";
import { handleWordKey, tickWords, type WordsEngineState, type WordsEngineConfig, type WordsEvent, type WordsWord } from "./wordsEngine";

/**
 * Canvas 2D renderer for the Words game. Owns the requestAnimationFrame loop, drives the pure engine, assigns lanes to newly
 * spawned meteors and draws the space scene. It never mutates game rules; graphics use their own seeded random and a scene
 * clock that stands still while the game is paused.
 */

const clampDt = (dt: number): number => Math.min(dt, 100);

const BOLT_MS = 150;
const SHAKE_MS = 380;
const LABEL_FONT = "700 21px system-ui, sans-serif";
const TRANSLATION_FONT = "600 15px system-ui, sans-serif";
const COLOR_REST = "#f2f5ff";
const COLOR_REST_VOCAB = "#ffd24a";
const GOLD = "#ffc83d";
const COLOR_TYPED = "#4be3a0";
const COLOR_NEXT = "#ffffff";
const COLOR_TYPED_SLIPPED = "#ff9b8a";
const COLOR_REST_SLIPPED = "#ff4533";
const ACCENT = "#6ab7ff";

export interface WordsSceneOptions {
  config: WordsEngineConfig;
  engine: WordsEngineState;
  onEvents: (events: WordsEvent[]) => void;
  level: number;
  lanes: number;
  paused: () => boolean;
}

interface Bolt {
  planIndex: number;
  x0: number;
  y0: number;
  age: number;
  /** the shot that destroys the meteor: the explosion starts when it lands */
  final: boolean;
}

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

interface Blast {
  x: number;
  y: number;
  r: number;
  age: number;
  color: string;
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
  private dpr = 1;
  /** scene clock in ms; advances only while the game runs */
  private clock = 0;
  private bolts: Bolt[] = [];
  private particles: Particle[] = [];
  private blasts: Blast[] = [];
  /** meteors already blown up: no longer drawn */
  private gone = new Set<number>();
  private shipAngle = 0;
  private aim: { x: number; y: number; until: number } | null = null;
  private muzzle = 0;
  private seenErrorSeq = 0;
  private shakeStart = -Infinity;
  private shakePlanIndex: number | null = null;

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
        this.clock += dt;
        const { events } = tickWords(this.engine, this.config, dt);
        if (events.length) {
          if (events.some((e) => e.type === "failed")) this.blowUpBreakthrough();
          this.onEvents(events);
        }
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

  key(k: string): WordsEvent[] {
    if (this.paused()) return [];
    const events = handleWordKey(this.engine, this.config, k);
    for (const e of events) {
      if (e.type === "hit") this.fire(e.word, events.some((x) => x.type === "destroyed"));
    }
    if (events.length) this.onEvents(events);
    return events;
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
  private shipPos(): { x: number; y: number } {
    return { x: this.w() / 2, y: this.h() - 44 };
  }
  private lineY(): number {
    return this.h() - 90;
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

  private place(word: WordsWord): { x: number; y: number; r: number } {
    const laneW = this.w() / this.lanes;
    return { x: laneW * (Math.max(1, word.lane) - 0.5), y: word.y * this.lineY(), r: Math.max(28, Math.min(48, word.lemma.length * 4.8)) };
  }

  private visualOf(word: WordsWord): MeteorVisual {
    return this.visuals.get(word.planIndex) ?? makeMeteorVisual(word.planIndex, this.level, word.lemma.length > 9);
  }

  /** one correct letter = one shot: turn the ship towards the meteor and send a bolt */
  private fire(word: WordsWord, final: boolean): void {
    const p = this.place(word);
    const ship = this.shipPos();
    const angle = Math.atan2(p.x - ship.x, ship.y - p.y);
    this.aim = { x: p.x, y: p.y, until: this.clock + 500 };
    // start turning at once so the very first bolt leaves roughly along the barrel
    this.shipAngle += (this.clampAngle(angle) - this.shipAngle) * 0.6;
    this.muzzle = 1;
    const nose = 34;
    this.bolts.push({ planIndex: word.planIndex, x0: ship.x + Math.sin(this.shipAngle) * nose, y0: ship.y - Math.cos(this.shipAngle) * nose, age: 0, final });
  }

  private clampAngle(a: number): number {
    return Math.max(-1.25, Math.min(1.25, a));
  }

  private explode(x: number, y: number, r: number, colors: string[], count: number): void {
    this.blasts.push({ x, y, r, age: 0, color: colors[0]! });
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = (0.05 + Math.random() * 0.28) * (r / 30);
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 500 + Math.random() * 500, age: 0, size: 1.5 + Math.random() * 3.5, color: colors[i % colors.length]! });
    }
  }

  /** a meteor that reached the line explodes in red; the meteor stays drawn until then so the loss is visible */
  private blowUpBreakthrough(): void {
    for (const w of this.engine.words) {
      if (w.destroying || w.y < 1) continue;
      const p = this.place(w);
      this.explode(p.x, p.y, p.r * 1.6, ["#ff5a3a", "#ffb04a", "#fff0c0"], 50);
      this.gone.add(w.planIndex);
    }
  }

  private stepFx(dt: number): void {
    for (const b of this.bolts) b.age += dt;
    const landed = this.bolts.filter((b) => b.age >= BOLT_MS);
    this.bolts = this.bolts.filter((b) => b.age < BOLT_MS);
    for (const b of landed) {
      const word = this.engine.words.find((w) => w.planIndex === b.planIndex);
      if (!word) continue;
      const p = this.place(word);
      const colors = [this.visualOf(word).palette.light, this.visualOf(word).palette.glow, "#ffffff"];
      if (b.final) {
        this.gone.add(word.planIndex);
        this.explode(p.x, p.y, p.r * 1.5, colors, 36);
      } else {
        this.explode(p.x, p.y + p.r * 0.2, p.r * 0.35, colors, 5);
      }
    }
    for (const p of this.particles) {
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.985;
      p.vy *= 0.985;
    }
    this.particles = this.particles.filter((p) => p.age < p.life);
    for (const b of this.blasts) b.age += dt;
    this.blasts = this.blasts.filter((b) => b.age < 600);
    this.muzzle = Math.max(0, this.muzzle - dt / 120);
    if (this.engine.errorSeq !== this.seenErrorSeq) {
      this.seenErrorSeq = this.engine.errorSeq;
      this.shakeStart = this.clock;
      this.shakePlanIndex = this.engine.errorPlanIndex;
    }
    // turn towards the aimed point, or back to the centre when idle
    const target = this.aim && this.aim.until > this.clock ? this.clampAngle(Math.atan2(this.aim.x - this.shipPos().x, this.shipPos().y - this.aim.y)) : 0;
    this.shipAngle += (target - this.shipAngle) * (1 - Math.exp(-dt / 70));
  }

  private shakeOffset(word: WordsWord): number {
    if (this.shakePlanIndex !== null && this.shakePlanIndex !== word.planIndex) return 0;
    const age = this.clock - this.shakeStart;
    if (age < 0 || age >= SHAKE_MS) return 0;
    return Math.sin(age * 0.11) * 8 * (1 - age / SHAKE_MS);
  }

  private drawLabel(word: WordsWord, cx: number, baseline: number, active: boolean): void {
    const ctx = this.ctx;
    const planWord = this.engine.plan[word.planIndex];
    ctx.font = LABEL_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    const typed = word.lemma.slice(0, word.progress);
    const next = word.lemma[word.progress] ?? "";
    const rest = word.lemma.slice(word.progress + 1);
    const wTyped = ctx.measureText(typed).width;
    const wNext = ctx.measureText(next).width;
    const wRest = ctx.measureText(rest).width;
    const total = wTyped + wNext + wRest;
    const x0 = cx - total / 2 + this.shakeOffset(word);
    const top = baseline - 23;

    const mine = planWord?.source === "vocabulary";
    ctx.fillStyle = active ? "rgba(10,20,50,0.88)" : "rgba(5,8,25,0.7)";
    ctx.beginPath();
    ctx.roundRect(x0 - 10, top, total + 20, 32, 9);
    ctx.fill();
    if (active || mine) {
      ctx.strokeStyle = mine ? GOLD : ACCENT;
      ctx.lineWidth = mine ? 2 : 1.5;
      ctx.stroke();
    }
    // one wrong key or more turns the word scarlet
    const slipped = word.mistakes > 0;
    ctx.fillStyle = slipped ? COLOR_TYPED_SLIPPED : COLOR_TYPED;
    ctx.fillText(typed, x0, baseline);
    ctx.fillStyle = COLOR_NEXT;
    ctx.fillText(next, x0 + wTyped, baseline);
    // the letter to type next is underlined
    if (next) {
      ctx.fillStyle = ACCENT;
      ctx.fillRect(x0 + wTyped, baseline + 4, wNext, 2.5);
    }
    ctx.fillStyle = slipped ? COLOR_REST_SLIPPED : planWord?.source === "vocabulary" ? COLOR_REST_VOCAB : COLOR_REST;
    ctx.fillText(rest, x0 + wTyped + wNext, baseline);

    const translation = firstTranslation(planWord?.translationRu);
    if (planWord?.source === "vocabulary" && translation) {
      ctx.font = TRANSLATION_FONT;
      const tw = ctx.measureText(translation).width;
      const tx = cx - tw / 2 + this.shakeOffset(word) * 0.4;
      ctx.fillStyle = "rgba(5,8,25,0.7)";
      ctx.beginPath();
      ctx.roundRect(tx - 8, top + 36, tw + 16, 23, 7);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,200,61,0.6)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "#ffd9a0";
      ctx.fillText(translation, tx, top + 52);
    }
  }

  private draw(): void {
    this.assignLanes();
    const ctx = this.ctx;
    const w = this.w();
    const h = this.h();
    const t = this.clock / 1000;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    drawBackground(ctx, this.bg, w, h, t);

    // defence line
    const lineY = this.lineY();
    const lineGlow = ctx.createLinearGradient(0, lineY - 14, 0, lineY + 14);
    lineGlow.addColorStop(0, "rgba(106,183,255,0)");
    lineGlow.addColorStop(0.5, "rgba(106,183,255,0.18)");
    lineGlow.addColorStop(1, "rgba(106,183,255,0)");
    ctx.fillStyle = lineGlow;
    ctx.fillRect(0, lineY - 14, w, 28);
    ctx.strokeStyle = "rgba(140,200,255,0.65)";
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(0, lineY);
    ctx.lineTo(w, lineY);
    ctx.stroke();
    ctx.setLineDash([]);

    const target = this.engine.target !== null ? this.engine.words[this.engine.target] : undefined;
    const labels: Array<{ word: WordsWord; cx: number; baseline: number; active: boolean }> = [];
    for (const word of this.engine.words) {
      if (this.gone.has(word.planIndex)) continue;
      const p = this.place(word);
      const visual = this.visualOf(word);
      visual.rotation += visual.spin;
      const danger = Math.max(0, word.y - 0.5) * 2;
      const active = target === word && !word.destroying;
      const baseline = drawMeteor(ctx, visual, p.x, p.y, p.r, danger, t, active, this.engine.plan[word.planIndex]?.source === "vocabulary" ? GOLD : undefined);
      if (active) this.drawReticle(p.x, p.y, p.r, t);
      labels.push({ word, cx: p.x, baseline, active });
    }
    // labels on top of every meteor so a neighbouring rock never covers a word
    for (const l of labels) if (!l.word.destroying) this.drawLabel(l.word, l.cx, l.baseline, l.active);

    this.drawFx();
    const ship = this.shipPos();
    drawShip(ctx, ship.x, ship.y, this.shipAngle, t, this.muzzle);
  }

  /** rotating targeting ring around the meteor the player is typing */
  private drawReticle(x: number, y: number, r: number, t: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(t * 1.2);
    ctx.strokeStyle = "rgba(120,200,255,0.9)";
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 8]);
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.35, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    ctx.setLineDash([]);
  }

  private drawFx(): void {
    const ctx = this.ctx;
    for (const b of this.bolts) {
      const word = this.engine.words.find((w) => w.planIndex === b.planIndex);
      if (!word) continue;
      const p = this.place(word);
      const k = Math.min(1, b.age / BOLT_MS);
      const head = { x: b.x0 + (p.x - b.x0) * k, y: b.y0 + (p.y - b.y0) * k };
      const tk = Math.max(0, k - 0.3);
      const tail = { x: b.x0 + (p.x - b.x0) * tk, y: b.y0 + (p.y - b.y0) * tk };
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";
      ctx.strokeStyle = "rgba(90,200,255,0.55)";
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(tail.x, tail.y);
      ctx.lineTo(head.x, head.y);
      ctx.stroke();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const b of this.blasts) {
      const k = b.age / 600;
      const flash = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r * (0.6 + k));
      flash.addColorStop(0, rgba("#ffffff", 0.9 * (1 - k)));
      flash.addColorStop(0.4, rgba(b.color, 0.55 * (1 - k)));
      flash.addColorStop(1, rgba(b.color, 0));
      ctx.fillStyle = flash;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r * (0.6 + k), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba(b.color, 0.7 * (1 - k));
      ctx.lineWidth = 3 * (1 - k) + 0.5;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r * (0.3 + k * 1.6), 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const p of this.particles) {
      const k = 1 - p.age / p.life;
      ctx.fillStyle = rgba(p.color, Math.max(0, k));
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * k + 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
