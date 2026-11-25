/**
 * `vt-estimate-v2` (D173, TASK_038 section 6): how many words of the pool the learner knows, from a stratified sample. A pure function of the screening
 * results; the language model never takes part. Words are grouped in bands of 1000 frequency ranks. Probes (random unscreened words of the thinnest
 * bands) keep the sample unbiased: the in-order words are the most frequent ones, so they alone would overstate the vocabulary.
 */
export const ESTIMATE_VERSION = "vt-estimate-v2";
/** below this many screened words no number is shown */
export const MIN_SCREENED = 100;
/** a band's own sample is used from this size on */
export const MIN_BAND_SAMPLE = 10;

export interface BandInput {
  band: number;
  /** words of the pool in the band (excluded words are not counted) */
  pool: number;
  /** screened words by their ORIGINAL screening result */
  known: number;
  unknown: number;
  /** the same, for probe words only */
  probeKnown: number;
  probeUnknown: number;
}

export interface BandEstimate {
  band: number;
  pool: number;
  screened: number;
  known: number;
  /** estimated share of known words among the unscreened words of the band (after smoothing) */
  p: number;
  /** words used for p (0 = interpolated) */
  n: number;
  source: "probes" | "screened" | "interpolated";
  expectedKnown: number;
}

export interface Estimate {
  version: string;
  /** null when fewer than MIN_SCREENED words are screened */
  estimate: number | null;
  low: number | null;
  high: number | null;
  screened: number;
  probes: number;
  /** the pool plus the assumed-known top words */
  poolSize: number;
  /** the most frequent words the pool skips, counted as known by assumption (D177) and already inside the numbers */
  assumedKnown: number;
  bands: BandEstimate[];
}

/** pool-adjacent-violators: the closest non-increasing sequence (weights = sample sizes) */
export function monotoneDecreasing(values: readonly number[], weights: readonly number[]): number[] {
  const blocks: Array<{ sum: number; w: number; len: number }> = [];
  values.forEach((v, i) => {
    blocks.push({ sum: v * weights[i]!, w: weights[i]!, len: 1 });
    while (blocks.length >= 2) {
      const b = blocks[blocks.length - 1]!;
      const a = blocks[blocks.length - 2]!;
      if (a.sum / a.w >= b.sum / b.w) break;
      blocks.splice(blocks.length - 2, 2, { sum: a.sum + b.sum, w: a.w + b.w, len: a.len + b.len });
    }
  });
  return blocks.flatMap((b) => Array<number>(b.len).fill(b.w > 0 ? b.sum / b.w : 0));
}

export function estimateVocabulary(input: readonly BandInput[], assumedKnown = 0): Estimate {
  const bands = [...input].sort((a, b) => a.band - b.band);
  const screened = bands.reduce((s, b) => s + b.known + b.unknown, 0);
  const probes = bands.reduce((s, b) => s + b.probeKnown + b.probeUnknown, 0);
  const poolSize = bands.reduce((s, b) => s + b.pool, 0) + assumedKnown;
  const raw = bands.map((b) => {
    const pn = b.probeKnown + b.probeUnknown;
    const sn = b.known + b.unknown;
    if (pn >= MIN_BAND_SAMPLE) return { p: b.probeKnown / pn, n: pn, source: "probes" as const };
    if (sn >= MIN_BAND_SAMPLE) return { p: b.known / sn, n: sn, source: "screened" as const };
    return { p: NaN, n: 0, source: "interpolated" as const };
  });
  // bands without a usable sample take the nearest measured neighbours (linear between them, flat beyond the ends)
  const measured = raw.map((r, i) => (Number.isNaN(r.p) ? -1 : i)).filter((i) => i >= 0);
  const filled = raw.map((r, i) => {
    if (!Number.isNaN(r.p)) return r.p;
    if (measured.length === 0) return 0.5;
    const left = [...measured].reverse().find((m) => m < i);
    const right = measured.find((m) => m > i);
    if (left === undefined) return raw[right!]!.p;
    if (right === undefined) return raw[left]!.p;
    return raw[left]!.p + ((raw[right]!.p - raw[left]!.p) * (i - left)) / (right - left);
  });
  // rarer words cannot be better known than commoner ones on average
  const weights = raw.map((r) => Math.max(1, r.n));
  const p = monotoneDecreasing(filled, weights);
  let total = 0;
  let variance = 0;
  const out: BandEstimate[] = bands.map((b, i) => {
    const remaining = Math.max(0, b.pool - b.known - b.unknown);
    const pi = Math.min(1, Math.max(0, p[i]!));
    const n = Math.max(1, raw[i]!.n);
    total += b.known + remaining * pi;
    variance += (remaining * remaining * pi * (1 - pi)) / n;
    return { band: b.band, pool: b.pool, screened: b.known + b.unknown, known: b.known, p: pi, n: raw[i]!.n, source: raw[i]!.source, expectedKnown: b.known + remaining * pi };
  });
  if (screened < MIN_SCREENED) return { version: ESTIMATE_VERSION, estimate: null, low: null, high: null, screened, probes, poolSize, assumedKnown, bands: out };
  const half = 1.96 * Math.sqrt(variance);
  return {
    version: ESTIMATE_VERSION,
    estimate: Math.round(total) + assumedKnown,
    low: Math.max(assumedKnown, Math.round(total - half) + assumedKnown),
    high: Math.min(poolSize, Math.round(total + half) + assumedKnown),
    screened,
    probes,
    poolSize,
    assumedKnown,
    bands: out,
  };
}
