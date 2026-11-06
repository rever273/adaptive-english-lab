// Pure helpers of `npm run voices:evaluate` (TASK_029): clip measurements and the rules that turn a run into proposed voice settings.
// No I/O here, so the rules are unit-tested (tests/unit/voices/evaluate.test.ts).

export const SCRIPT_VERSION = 1;

export const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** 16-bit mono WAV: samples and sample rate */
export function parseWav(buf) {
  let p = 12;
  let rate = 22050;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === "fmt ") rate = buf.readUInt32LE(p + 12);
    if (id === "data") {
      const len = Math.min(size, buf.length - p - 8);
      return { rate, samples: new Int16Array(buf.buffer.slice(buf.byteOffset + p + 8, buf.byteOffset + p + 8 + len - (len % 2))) };
    }
    p += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

/**
 * Real clipping is a run of samples stuck at the limit. Piper normalises the loudness, so the single loudest sample of every clip sits at the
 * limit and says nothing: the first check reported "clipping" for all 240 clips.
 */
export function clippedRuns(samples, { limit = 32700, run = 3 } = {}) {
  let runs = 0;
  let len = 0;
  for (const v of samples) {
    if (Math.abs(v) >= limit) {
      len++;
      if (len === run) runs++;
    } else len = 0;
  }
  return runs;
}

const words = (s) => s.split(/\s+/).filter(Boolean).length;

/** loudness per 10 ms window, then speech rate, ending and pauses inside the sentence */
export function measure(buf, text, { pauseMs = 700 } = {}) {
  const { rate, samples } = parseWav(buf);
  const win = Math.max(1, Math.round(rate * 0.01));
  const rms = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    let s = 0;
    for (let k = 0; k < win; k++) s += samples[i + k] ** 2;
    rms.push(Math.sqrt(s / win));
  }
  const peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const gate = Math.max(80, peak * 0.02);
  const first = rms.findIndex((v) => v > gate);
  let last = rms.length - 1;
  while (last > 0 && rms[last] <= gate) last--;
  const speechSeconds = Math.max(0.01, (last - first + 1) * 0.01);
  let longPauses = 0;
  let quiet = 0;
  for (let i = Math.max(0, first); i <= last; i++) {
    if (rms[i] <= gate) quiet++;
    else {
      if (quiet * 10 >= pauseMs) longPauses++;
      quiet = 0;
    }
  }
  const tailMs = (rms.length - 1 - last) * 10;
  return {
    durationMs: Math.round((samples.length / rate) * 1000),
    speechSeconds,
    wpm: Math.round((words(text) / speechSeconds) * 60),
    tailMs,
    clippedEnd: tailMs < 20 && rms[rms.length - 1] > peak * 0.1,
    peak,
    trueClip: clippedRuns(samples),
    longPauses,
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x, p = 3) => (x === null ? null : Math.round(x * 10 ** p) / 10 ** p);

/** exact rate, WER, median MOS and pace of a list of clips */
export function summarize(clips) {
  const scored = clips.filter((c) => c.wordErrors !== null);
  const expectedWords = scored.reduce((a, c) => a + words(c.text), 0);
  return {
    n: clips.length,
    exactRate: scored.length ? round(scored.filter((c) => c.wordErrors === 0).length / scored.length) : null,
    wer: expectedWords ? round(scored.reduce((a, c) => a + c.wordErrors, 0) / expectedWords) : null,
    mos: round(median(clips.map((c) => c.metrics.mos).filter((m) => typeof m === "number"))),
    wpm: round(mean(clips.map((c) => c.metrics.wpm)), 0),
    minWordProb: round(median(clips.map((c) => c.metrics.minWordProb).filter((m) => typeof m === "number"))),
    trueClip: clips.filter((c) => c.metrics.trueClip > 0).length,
    longPauses: clips.filter((c) => c.metrics.longPauses > 0).length,
  };
}

/**
 * What a run of one voice suggests for its settings (never the weight, `enabled`, age or topics: those are the learner's).
 * `sub[f]`: the common subset at the pace factor f (1.1, 1, 0.9, 0.8) for a like-for-like comparison; `full[f]`: every sentence at f (1, 0.9, 0.8);
 * `noise`: the subset at factor 1 with a narrower rhythm noise (noise_w_scale 0.5).
 */
export function recommend(current, { sub, full, noise }) {
  const patch = {};
  const notes = [];
  const base = sub[1];
  const candidates = Object.entries(sub).filter(([, s]) => s && s.exactRate !== null && s.exactRate >= 0.9).map(([f, s]) => ({ f: Number(f), ...s }));
  if (candidates.length > 0) {
    const withMos = candidates.every((c) => c.mos !== null);
    const top = withMos ? Math.max(...candidates.map((c) => c.mos)) : null;
    const near = candidates.filter((c) => (withMos ? top - c.mos < 0.05 : true));
    // a near tie in quality goes to the faster delivery: the voices were slow to begin with, and "words a minute" cannot tell a short-word phrase from a long-word one
    const best = [...near].sort((a, b) => a.f - b.f)[0];
    if (best.f !== 1) {
      patch.lengthScale = Math.min(1.8, Math.max(0.7, Math.round(current.lengthScale * best.f * 100) / 100));
      notes.push(`pace ${current.lengthScale} -> ${patch.lengthScale} (x${best.f}: ${withMos ? `MOS ${best.mos}, ` : ""}exact ${best.exactRate}, ${best.wpm} wpm)`);
    }
  } else notes.push("no pace reached 90% exact: the pace is kept");
  let speedUp = current.maxSpeedUp;
  if (full[0.8]?.exactRate !== null && full[0.8]?.exactRate < 0.85) speedUp = Math.min(speedUp, 0.1);
  if (full[0.8]?.exactRate !== null && full[0.8]?.exactRate < 0.85 && full[0.9]?.exactRate !== null && full[0.9]?.exactRate < 0.85) speedUp = 0;
  if (speedUp < current.maxSpeedUp) {
    patch.maxSpeedUp = speedUp;
    notes.push(`max speed-up ${current.maxSpeedUp} -> ${speedUp} (exact ${full[0.8]?.exactRate} at x0.8, ${full[0.9]?.exactRate} at x0.9)`);
  }
  if (noise && base && noise.mos !== null && base.mos !== null && noise.mos - base.mos >= 0.1 && noise.exactRate >= base.exactRate) {
    patch.noiseWScale = 0.5;
    notes.push(`noise_w_scale 0.5 (MOS ${base.mos} -> ${noise.mos}, exact ${base.exactRate} -> ${noise.exactRate})`);
  }
  return { patch, notes };
}
