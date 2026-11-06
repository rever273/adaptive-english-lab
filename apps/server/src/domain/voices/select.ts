import { createHash } from "node:crypto";
import type { Voice } from "./catalog.js";

/** a voice with the weight it has for the purpose at hand */
export interface Weighted {
  voice: Voice;
  weight: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** a number or a string seed as a generator (a string is hashed, so the same text always gives the same draws) */
export const randomFor = (seed: string | number): (() => number) => mulberry32(typeof seed === "number" ? seed : createHash("sha256").update(seed).digest().readUInt32BE(0));

/** a voice is not given topics of the groups it avoids (an elderly voice does not talk about video games), unless nothing else is left */
export const voiceSuits = (voice: Pick<Voice, "avoidGroups">, group: string | undefined): boolean => !(group && voice.avoidGroups.includes(group));

export function pickWeighted<T>(items: ReadonlyArray<readonly [T, number]>, rand: () => number): T {
  const total = items.reduce((a, [, w]) => a + w, 0);
  let x = rand() * total;
  for (const [t, w] of items) {
    x -= w;
    if (x <= 0) return t;
  }
  return items[items.length - 1]![0];
}

const usable = (candidates: readonly Weighted[]): Weighted[] => candidates.filter((c) => c.weight > 0);

/** one voice for one sentence: a weighted draw among the voices that suit the topic, none of `exclude`, and not the one just heard when another exists */
export function pickVoice(candidates: readonly Weighted[], o: { seed: string | number; topicGroup?: string; exclude?: readonly string[]; previousKey?: string }): Voice | null {
  const rand = randomFor(o.seed);
  const open = usable(candidates).filter((c) => !o.exclude?.includes(c.voice.key));
  if (open.length === 0) return null;
  const suitable = open.filter((c) => voiceSuits(c.voice, o.topicGroup));
  const pool = suitable.length > 0 ? suitable : open;
  const free = pool.length > 1 ? pool.filter((c) => c.voice.key !== o.previousKey) : pool;
  return pickWeighted(free.map((c) => [c.voice, c.weight] as const), rand);
}

/** a voice already used in this plan is a little less likely again (0.8^used); short plans keep the differences between the weights */
const REPEAT_PENALTY = 0.8;

/**
 * One voice per sentence (D85, D124): a weighted draw among the voices that suit the topic, never the same voice twice in a row, a little less
 * likely for a voice already used in this plan, and both genders when the plan is long enough (the voice that fills the gap is drawn by weight too).
 */
export function planVoiceList(candidates: readonly Weighted[], count: number, seed: string | number, groups: ReadonlyArray<string | undefined> = []): Voice[] {
  const enabled = usable(candidates);
  if (enabled.length === 0) return [];
  const rand = randomFor(seed);
  const used = new Map<string, number>();
  const plan: Voice[] = [];
  const chosen = (list: readonly Weighted[]): Voice =>
    pickWeighted(list.map((c) => [c.voice, c.weight * REPEAT_PENALTY ** (used.get(c.voice.key) ?? 0)] as const), rand);
  for (let i = 0; i < count; i++) {
    const suitable = enabled.filter((c) => voiceSuits(c.voice, groups[i]));
    const pool = suitable.length > 0 ? suitable : enabled;
    const prev = plan[i - 1];
    const v = chosen(pool.length > 1 ? pool.filter((c) => c.voice.key !== prev?.key) : pool);
    plan.push(v);
    used.set(v.key, (used.get(v.key) ?? 0) + 1);
  }
  if (count >= 2 && new Set(plan.map((v) => v.gender)).size === 1) {
    const other = enabled.filter((c) => c.voice.gender !== plan[0]!.gender);
    const at = Math.floor(rand() * count);
    const apart = (c: Weighted) => plan[at - 1]?.key !== c.voice.key && plan[at + 1]?.key !== c.voice.key;
    const fit = other.filter((c) => voiceSuits(c.voice, groups[at]) && apart(c));
    const options = fit.length > 0 ? fit : other.filter(apart);
    if (options.length > 0) plan[at] = pickWeighted(options.map((c) => [c.voice, c.weight] as const), rand);
  }
  return plan;
}

/** a second voice for a sentence the first could not say clearly: drawn by weight among the others, one that suits the topic if possible */
export function alternativeVoice(candidates: readonly Weighted[], o: { failed: readonly string[]; topicGroup?: string; seed: string | number }): Voice | null {
  const rand = randomFor(o.seed);
  const open = usable(candidates).filter((c) => !o.failed.includes(c.voice.key));
  if (open.length === 0) return null;
  const suitable = open.filter((c) => voiceSuits(c.voice, o.topicGroup));
  return pickWeighted((suitable.length > 0 ? suitable : open).map((c) => [c.voice, c.weight] as const), rand);
}
