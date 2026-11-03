/**
 * Procedural graphics for the typing games (D78): everything is drawn in code on Canvas 2D, no image assets, no dependencies.
 * The visual layer is fully separated from the engine: it reads engine state and renders it. A per-meteor seeded random
 * generator keeps shapes stable across frames without affecting game rules.
 */

export type MeteorType = "rock" | "ice" | "magma" | "crystal" | "metal" | "comet";

const TYPES: MeteorType[] = ["rock", "ice", "magma", "crystal", "metal", "comet"];
/** new meteor types unlock as the level grows (first levels: 3, all 6 around level 8) */
export function availableTypes(level: number): MeteorType[] {
  const count = level <= 2 ? 3 : level <= 4 ? 4 : level <= 6 ? 5 : 6;
  return TYPES.slice(0, count);
}

/** deterministic hash for a stable shape/colour per meteor */
export function seedOf(planIndex: number): number {
  let h = (planIndex + 1) * 0x9e3779b9;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MeteorPalette {
  base: string;
  dark: string;
  light: string;
  glow: string;
}

const PALETTES: Record<MeteorType, MeteorPalette> = {
  rock: { base: "#8a7a63", dark: "#5c4f3d", light: "#b3a184", glow: "#c9b896" },
  ice: { base: "#7fb9e8", dark: "#3f78a8", light: "#cfe9ff", glow: "#bfe3ff" },
  magma: { base: "#5a2f1f", dark: "#2c1710", light: "#ff8a3d", glow: "#ff6a2a" },
  crystal: { base: "#7f6ad4", dark: "#453a86", light: "#c8b8ff", glow: "#b7a4ff" },
  metal: { base: "#7e8791", dark: "#49505a", light: "#d7dee6", glow: "#e8eef5" },
  comet: { base: "#6aa3c4", dark: "#3a5f78", light: "#d9f1ff", glow: "#aee2ff" },
};

export interface MeteorVisual {
  type: MeteorType;
  palette: MeteorPalette;
  /** irregular polygon radius, normalised around 1 */
  points: Array<{ a: number; r: number }>;
  /** slow rotation in rad/frame at 60fps */
  spin: number;
  rotation: number;
  /** small craters / cracks as normalised offsets */
  features: Array<{ x: number; y: number; r: number }>;
}

export function makeMeteorVisual(planIndex: number, level: number, longWord: boolean): MeteorVisual {
  const rnd = mulberry32(seedOf(planIndex));
  const types = availableTypes(level);
  const type = types[Math.floor(rnd() * types.length)]!;
  const n = 8 + Math.floor(rnd() * 5);
  const points = [];
  for (let i = 0; i < n; i++) {
    points.push({ a: (i / n) * Math.PI * 2, r: 0.78 + rnd() * 0.22 });
  }
  const features = [];
  const fCount = longWord ? 5 : 3;
  for (let i = 0; i < fCount; i++) features.push({ x: rnd() * 2 - 1, y: rnd() * 2 - 1, r: 0.05 + rnd() * 0.1 });
  return { type, palette: PALETTES[type], points, spin: (rnd() - 0.5) * 0.01, rotation: rnd() * Math.PI * 2, features };
}

export interface Background {
  stars: Array<{ x: number; y: number; r: number; layer: number }>;
  nebula: string;
  planet: { x: number; y: number; r: number; color: string };
}

export function makeBackground(seed: number): Background {
  const rnd = mulberry32(seed);
  const stars = [];
  for (let i = 0; i < 120; i++) {
    stars.push({ x: rnd(), y: rnd(), r: 0.4 + rnd() * 1.6, layer: rnd() < 0.7 ? 0.3 : rnd() < 0.5 ? 0.6 : 1 });
  }
  const hues = ["#231a3a", "#1b2a3a", "#2a1b33", "#12202b"];
  return {
    stars,
    nebula: hues[Math.floor(rnd() * hues.length)]!,
    planet: { x: 0.15 + rnd() * 0.7, y: 0.2 + rnd() * 0.3, r: 24 + rnd() * 40, color: ["#3f5d78", "#7a5a3a", "#5a3a6a"][Math.floor(rnd() * 3)]! },
  };
}

/** draw a meteor at (cx, cy) with radius r; returns the text baseline for the label */
export function drawMeteor(ctx: CanvasRenderingContext2D, v: MeteorVisual, cx: number, cy: number, r: number, danger: number): number {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(v.rotation);
  const p = v.palette;
  const grad = ctx.createRadialGradient(0, 0, r * 0.1, 0, 0, r);
  grad.addColorStop(0, p.light);
  grad.addColorStop(0.6, p.base);
  grad.addColorStop(1, p.dark);
  ctx.beginPath();
  v.points.forEach((pt, i) => {
    const a = pt.a;
    const rr = r * pt.r * (1 + danger * 0.06);
    const x = Math.cos(a) * rr;
    const y = Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  if (danger > 0.4) {
    ctx.strokeStyle = `rgba(255,60,40,${(danger - 0.4) * 1.5})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  // craters / cracks
  ctx.fillStyle = p.dark;
  for (const f of v.features) {
    ctx.beginPath();
    ctx.arc(f.x * r * 0.6, f.y * r * 0.6, f.r * r, 0, Math.PI * 2);
    ctx.fill();
  }
  // comet tail
  if (v.type === "comet") {
    ctx.fillStyle = "rgba(174,226,255,0.25)";
    ctx.beginPath();
    ctx.moveTo(-r * 0.9, 0);
    ctx.lineTo(-r * 2.4, r * 0.3);
    ctx.lineTo(-r * 2.4, -r * 0.3);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  return cy + r + 20;
}

export function drawShip(ctx: CanvasRenderingContext2D, cx: number, cy: number, turn: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(turn);
  ctx.beginPath();
  ctx.moveTo(0, -18);
  ctx.lineTo(14, 14);
  ctx.lineTo(0, 8);
  ctx.lineTo(-14, 14);
  ctx.closePath();
  ctx.fillStyle = "#3aa0d8";
  ctx.fill();
  ctx.strokeStyle = "#bfe6ff";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // engine flame
  ctx.beginPath();
  ctx.moveTo(-5, 14);
  ctx.lineTo(0, 26);
  ctx.lineTo(5, 14);
  ctx.closePath();
  ctx.fillStyle = "#ff9a3d";
  ctx.fill();
  ctx.restore();
}
