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
  rock: { base: "#8a7a63", dark: "#4a3f31", light: "#c9b794", glow: "#e0b878" },
  ice: { base: "#7fb9e8", dark: "#2f6a9c", light: "#e4f4ff", glow: "#7fd0ff" },
  magma: { base: "#4a2418", dark: "#1f0f0a", light: "#ff9a4d", glow: "#ff5a1f" },
  crystal: { base: "#7f6ad4", dark: "#352c78", light: "#e0d4ff", glow: "#b07bff" },
  metal: { base: "#7e8791", dark: "#3a414b", light: "#e6edf5", glow: "#9fc4ff" },
  comet: { base: "#6aa3c4", dark: "#2c5068", light: "#e9f8ff", glow: "#58e0ff" },
};

export interface MeteorVisual {
  type: MeteorType;
  palette: MeteorPalette;
  /** irregular polygon radius, normalised around 1 */
  points: Array<{ a: number; r: number }>;
  /** slow rotation in rad/frame at 60fps */
  spin: number;
  rotation: number;
  /** craters / cracks / rivets as normalised offsets */
  features: Array<{ x: number; y: number; r: number }>;
  /** per-meteor phase for the pulsing glow */
  phase: number;
}

export function makeMeteorVisual(planIndex: number, level: number, longWord: boolean): MeteorVisual {
  const rnd = mulberry32(seedOf(planIndex));
  const types = availableTypes(level);
  const type = types[Math.floor(rnd() * types.length)]!;
  const n = type === "crystal" ? 8 + 2 * Math.floor(rnd() * 2) : 11 + Math.floor(rnd() * 6);
  const points = [];
  for (let i = 0; i < n; i++) {
    const r = type === "crystal" ? (i % 2 === 0 ? 1 : 0.72) * (0.92 + rnd() * 0.08) : 0.8 + rnd() * 0.2;
    points.push({ a: (i / n) * Math.PI * 2, r });
  }
  const features = [];
  const fCount = longWord ? 6 : 4;
  for (let i = 0; i < fCount; i++) features.push({ x: rnd() * 2 - 1, y: rnd() * 2 - 1, r: 0.07 + rnd() * 0.11 });
  return { type, palette: PALETTES[type], points, spin: (rnd() - 0.5) * 0.012, rotation: rnd() * Math.PI * 2, features, phase: rnd() * Math.PI * 2 };
}

export interface Background {
  stars: Array<{ x: number; y: number; r: number; layer: number; tw: number }>;
  nebulae: Array<{ x: number; y: number; r: number; color: string }>;
}

export function makeBackground(seed: number): Background {
  const rnd = mulberry32(seed);
  const stars = [];
  for (let i = 0; i < 150; i++) {
    stars.push({ x: rnd(), y: rnd(), r: 0.4 + rnd() * 1.5, layer: rnd() < 0.7 ? 0.3 : rnd() < 0.5 ? 0.6 : 1, tw: rnd() * Math.PI * 2 });
  }
  const nebulae = [
    { x: 0.18, y: 0.3, r: 0.38, color: "90,60,200" },
    { x: 0.82, y: 0.55, r: 0.42, color: "30,140,200" },
    { x: 0.5, y: 0.95, r: 0.5, color: "200,70,140" },
  ];
  return { stars, nebulae };
}

/** gradient sky, soft nebulae and twinkling parallax stars */
export function drawBackground(ctx: CanvasRenderingContext2D, bg: Background, w: number, h: number, t: number): void {
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, "#05071a");
  sky.addColorStop(0.55, "#0e1038");
  sky.addColorStop(1, "#2a1550");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  for (const n of bg.nebulae) {
    const r = n.r * Math.max(w, h);
    const g = ctx.createRadialGradient(n.x * w, n.y * h, 0, n.x * w, n.y * h, r);
    g.addColorStop(0, `rgba(${n.color},0.22)`);
    g.addColorStop(1, `rgba(${n.color},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  for (const s of bg.stars) {
    const y = (s.y * h + t * 9 * s.layer) % h;
    const twinkle = 0.65 + 0.35 * Math.sin(t * 1.6 + s.tw);
    ctx.fillStyle = `rgba(255,255,255,${(0.25 + s.layer * 0.5) * twinkle})`;
    ctx.beginPath();
    ctx.arc(s.x * w, y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** draw a meteor at (cx, cy) with radius r; returns the text baseline for the label */
export function drawMeteor(ctx: CanvasRenderingContext2D, v: MeteorVisual, cx: number, cy: number, r: number, danger: number, t: number, active: boolean, glowOverride?: string): number {
  const p = glowOverride ? { ...v.palette, glow: glowOverride } : v.palette;
  const pulse = 0.75 + 0.25 * Math.sin(t * 3 + v.phase);

  // glow halo, stronger for the locked target; red when close to the line
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const haloR = r * (active ? 2.7 : 2.1);
  const halo = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, haloR);
  halo.addColorStop(0, rgba(p.glow, (active ? 0.6 : 0.34) * pulse));
  halo.addColorStop(1, rgba(p.glow, 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
  ctx.fill();
  if (danger > 0.3) {
    const d = ctx.createRadialGradient(cx, cy, r * 0.8, cx, cy, r * 2.4);
    d.addColorStop(0, `rgba(255,60,40,${(danger - 0.3) * 0.5 * pulse})`);
    d.addColorStop(1, "rgba(255,60,40,0)");
    ctx.fillStyle = d;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // comet tail streams up, away from the direction of travel
  if (v.type === "comet") {
    const tail = ctx.createLinearGradient(cx, cy, cx, cy - r * 3.6);
    tail.addColorStop(0, rgba(p.glow, 0.5));
    tail.addColorStop(1, rgba(p.glow, 0));
    ctx.fillStyle = tail;
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.7, cy);
    ctx.lineTo(cx + r * 0.7, cy);
    ctx.lineTo(cx + r * 0.2, cy - r * 3.6);
    ctx.lineTo(cx - r * 0.2, cy - r * 3.6);
    ctx.closePath();
    ctx.fill();
  }

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(v.rotation);
  const body = () => {
    ctx.beginPath();
    v.points.forEach((pt, i) => {
      const rr = r * pt.r * (1 + danger * 0.05);
      const x = Math.cos(pt.a) * rr;
      const y = Math.sin(pt.a) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
  };
  // light comes from the top-left in screen space, so the highlight offset is counter-rotated
  const lx = Math.cos(-v.rotation - 2.4) * r * 0.45;
  const ly = Math.sin(-v.rotation - 2.4) * r * 0.45;
  const grad = ctx.createRadialGradient(lx, ly, r * 0.1, 0, 0, r * 1.05);
  grad.addColorStop(0, p.light);
  grad.addColorStop(0.5, p.base);
  grad.addColorStop(1, p.dark);
  body();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.lineJoin = "round";
  ctx.strokeStyle = v.type === "crystal" || v.type === "ice" ? rgba(p.light, 0.8) : rgba(p.dark, 0.9);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.save();
  body();
  ctx.clip();
  if (v.type === "crystal") {
    ctx.strokeStyle = rgba(p.light, 0.5);
    ctx.lineWidth = 1;
    for (const pt of v.points) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(pt.a) * r, Math.sin(pt.a) * r);
      ctx.stroke();
    }
  } else if (v.type === "metal") {
    ctx.fillStyle = rgba(p.dark, 0.5);
    ctx.fillRect(-r, -r * 0.12, r * 2, r * 0.24);
    ctx.fillStyle = rgba(p.light, 0.7);
    for (const f of v.features) {
      ctx.beginPath();
      ctx.arc(f.x * r * 0.7, f.y * r * 0.7, Math.max(1.2, f.r * r * 0.25), 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    for (const f of v.features) {
      const fx = f.x * r * 0.6;
      const fy = f.y * r * 0.6;
      const fr = f.r * r;
      if (v.type === "magma") {
        ctx.strokeStyle = rgba(p.glow, 0.55 + 0.4 * pulse);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(fx * 0.3 - fy * 0.5, fy * 0.3 + fx * 0.5);
        ctx.stroke();
      }
      ctx.fillStyle = rgba(p.dark, 0.75);
      ctx.beginPath();
      ctx.arc(fx, fy, fr, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba(p.light, 0.35);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(fx + fr * 0.15, fy + fr * 0.15, fr, 0.2, Math.PI * 0.9);
      ctx.stroke();
    }
  }
  ctx.restore();
  ctx.restore();

  // shadow on the side facing away from the light
  ctx.save();
  ctx.translate(cx, cy);
  const shade = ctx.createRadialGradient(-lx * 1.4, -ly * 1.4, r * 0.5, -lx * 1.4, -ly * 1.4, r * 1.3);
  shade.addColorStop(0, "rgba(0,0,0,0)");
  shade.addColorStop(1, "rgba(0,0,10,0.38)");
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.97, 0, Math.PI * 2);
  ctx.fillStyle = shade;
  ctx.fill();
  ctx.restore();
  return cy + r + 24;
}

/** player ship, nose up at angle 0; `angle` rotates it around its centre, `firing` (0..1) brightens the muzzle flash */
export function drawShip(ctx: CanvasRenderingContext2D, cx: number, cy: number, angle: number, t: number, firing: number, scale = 1.25): void {
  const flick = 0.8 + 0.2 * Math.sin(t * 40) + 0.1 * Math.sin(t * 23);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.scale(scale, scale);

  // engine flames
  for (const x of [-7, 7]) {
    const fl = ctx.createLinearGradient(0, 14, 0, 14 + 24 * flick);
    fl.addColorStop(0, "rgba(255,240,200,0.95)");
    fl.addColorStop(0.4, "rgba(255,150,50,0.8)");
    fl.addColorStop(1, "rgba(255,60,0,0)");
    ctx.fillStyle = fl;
    ctx.beginPath();
    ctx.moveTo(x - 4, 14);
    ctx.quadraticCurveTo(x, 14 + 30 * flick, x + 4, 14);
    ctx.closePath();
    ctx.fill();
  }
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const glow = ctx.createRadialGradient(0, 18, 2, 0, 18, 30);
  glow.addColorStop(0, `rgba(255,140,60,${0.35 * flick})`);
  glow.addColorStop(1, "rgba(255,140,60,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 18, 30, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // swept wings
  const wing = ctx.createLinearGradient(-22, 0, 22, 0);
  wing.addColorStop(0, "#1c3f78");
  wing.addColorStop(0.5, "#3f86d0");
  wing.addColorStop(1, "#1c3f78");
  ctx.fillStyle = wing;
  ctx.beginPath();
  ctx.moveTo(-5, -2);
  ctx.lineTo(-22, 17);
  ctx.lineTo(-21, 21);
  ctx.lineTo(-8, 15);
  ctx.lineTo(8, 15);
  ctx.lineTo(21, 21);
  ctx.lineTo(22, 17);
  ctx.lineTo(5, -2);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(190,225,255,0.7)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#ff5a4a";
  ctx.fillRect(-21, 17, 3, 3);
  ctx.fillRect(18, 17, 3, 3);

  // fuselage
  const hull = ctx.createLinearGradient(-8, 0, 8, 0);
  hull.addColorStop(0, "#9fb4cc");
  hull.addColorStop(0.45, "#f1f6fc");
  hull.addColorStop(1, "#7d93ae");
  ctx.fillStyle = hull;
  ctx.beginPath();
  ctx.moveTo(0, -26);
  ctx.bezierCurveTo(6, -14, 9, 0, 8, 14);
  ctx.lineTo(-8, 14);
  ctx.bezierCurveTo(-9, 0, -6, -14, 0, -26);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(60,90,130,0.8)";
  ctx.stroke();

  // cockpit glass
  const glass = ctx.createLinearGradient(0, -16, 0, -2);
  glass.addColorStop(0, "#d8f6ff");
  glass.addColorStop(1, "#1d7fc0");
  ctx.fillStyle = glass;
  ctx.beginPath();
  ctx.ellipse(0, -9, 3.6, 7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.beginPath();
  ctx.ellipse(-1, -11, 1, 3, 0, 0, Math.PI * 2);
  ctx.fill();

  // nozzles
  ctx.fillStyle = "#3a4558";
  ctx.fillRect(-10, 13, 6, 4);
  ctx.fillRect(4, 13, 6, 4);

  if (firing > 0) {
    ctx.globalCompositeOperation = "lighter";
    const f = ctx.createRadialGradient(0, -28, 0, 0, -28, 14);
    f.addColorStop(0, `rgba(180,240,255,${firing})`);
    f.addColorStop(1, "rgba(180,240,255,0)");
    ctx.fillStyle = f;
    ctx.beginPath();
    ctx.arc(0, -28, 14, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
