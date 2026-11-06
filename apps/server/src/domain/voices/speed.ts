import { createHash } from "node:crypto";

/**
 * A little variety in speed: each sentence is spoken up to `maxSpeedUp` (a voice setting, 20% by default) faster than the voice's calibrated pace
 * (most of them only slightly), so the learner also hears quicker, more conversational delivery. Deterministic for a seed; never slower than calibrated.
 */
export function speedFactor(seed: string, maxSpeedUp = 0.2): number {
  const u = createHash("sha256").update(seed).digest().readUInt32BE(0) / 4294967296;
  return 1 - maxSpeedUp * u * u;
}
export const MIN_LENGTH_SCALE = 0.85;
export const variedLengthScale = (base: number, seed: string, maxSpeedUp = 0.2): number => Math.max(MIN_LENGTH_SCALE, Math.min(base, Math.round(base * speedFactor(seed, maxSpeedUp) * 100) / 100));
