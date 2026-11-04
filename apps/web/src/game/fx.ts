import { rgba } from "./art";

/** Explosions for the typing scenes: a flash, a shock ring and sparks. Pure drawing state, no game rules. */

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

const BLAST_MS = 600;

export class Effects {
  private particles: Particle[] = [];
  private blasts: Blast[] = [];

  /** `colors` are hex strings; `r` is the meteor radius the blast belongs to */
  explode(x: number, y: number, r: number, colors: string[], count: number): void {
    this.blasts.push({ x, y, r, age: 0, color: colors[0]! });
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = (0.05 + Math.random() * 0.28) * (r / 30);
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 500 + Math.random() * 500, age: 0, size: 1.5 + Math.random() * 3.5, color: colors[i % colors.length]! });
    }
  }

  step(dt: number): void {
    for (const p of this.particles) {
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.985;
      p.vy *= 0.985;
    }
    this.particles = this.particles.filter((p) => p.age < p.life);
    for (const b of this.blasts) b.age += dt;
    this.blasts = this.blasts.filter((b) => b.age < BLAST_MS);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const b of this.blasts) {
      const k = b.age / BLAST_MS;
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
