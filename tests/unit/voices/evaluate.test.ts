import { describe, expect, it } from "vitest";
import { clippedRuns, measure, recommend, summarize } from "../../../scripts/lib/voiceMetrics.mjs";

/** a 16-bit mono WAV from sample values */
function wav(samples: number[], rate = 22050): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => buf.writeInt16LE(v, 44 + i * 2));
  return buf;
}
const tone = (seconds: number, amp = 8000, rate = 22050) => Array.from({ length: Math.round(seconds * rate) }, (_, i) => Math.round(amp * Math.sin(i / 8)));
const silence = (seconds: number, rate = 22050) => new Array<number>(Math.round(seconds * rate)).fill(0);

describe("clip measurements", () => {
  it("a normalised peak is not clipping, a run of samples stuck at the limit is", () => {
    expect(clippedRuns(Int16Array.from(tone(1, 32767)))).toBe(0); // the loudest sample of a normalised clip sits at the limit
    expect(clippedRuns(Int16Array.from([0, 32767, 0, 32767, 0]))).toBe(0); // isolated peaks
    expect(clippedRuns(Int16Array.from([0, 32767, 32767, 32767, 32767, 0, -32768, -32768, -32768, 0]))).toBe(2);
  });

  it("finds a long pause inside the sentence but not the silence at the ends", () => {
    const plain = measure(wav([...silence(0.3), ...tone(2), ...silence(0.5)]), "one two three four five six");
    expect(plain.longPauses).toBe(0);
    expect(plain.tailMs).toBeGreaterThanOrEqual(480);
    const paused = measure(wav([...tone(1), ...silence(1), ...tone(1)]), "one two three four five six");
    expect(paused.longPauses).toBe(1);
    expect(paused.wpm).toBeGreaterThan(0);
  });
});

const clip = (errors: number | null, mos: number | null, wpm = 175, text = "one two three four five six") => ({ text, wordErrors: errors, metrics: { mos, wpm, minWordProb: 0.9, trueClip: 0, longPauses: 0 } });

describe("summaries and proposals", () => {
  it("summarises exact rate, word errors and the median quality score", () => {
    const s = summarize([clip(0, 3.2), clip(0, 3.4), clip(1, 3.0), clip(0, null)]);
    expect(s).toMatchObject({ n: 4, exactRate: 0.75, mos: 3.2 });
    expect(s.wer).toBeCloseTo(1 / 24, 3);
  });

  const stats = (exactRate: number, mos: number | null, wpm: number) => ({ n: 20, exactRate, mos, wpm, wer: 0, minWordProb: 0.9, trueClip: 0, longPauses: 0 });
  const current = { lengthScale: 1.5, maxSpeedUp: 0.2 };

  it("proposes the pace with the best quality that is still 90% exact, and leaves the weight alone", () => {
    const { patch } = recommend(current, {
      sub: { 1.1: stats(0.95, 3.0, 150), 1: stats(0.95, 3.1, 170), 0.9: stats(0.95, 3.5, 185), 0.8: stats(0.8, 3.9, 205) },
      full: { 1: stats(0.95, 3.1, 170), 0.9: stats(0.93, 3.5, 185), 0.8: stats(0.9, 3.9, 205) },
      noise: null,
    });
    expect(patch).toEqual({ lengthScale: 1.35 }); // x0.9 beats x1; x0.8 is below 90% exact
    expect(Object.keys(patch)).not.toContain("priorWeight");
  });

  it("a near tie in quality goes to the faster pace", () => {
    const { patch } = recommend(current, {
      sub: { 1: stats(0.95, 3.30, 210), 0.9: stats(0.95, 3.32, 176), 0.8: stats(0.95, 3.31, 150) },
      full: { 1: stats(0.95, 3.3, 210), 0.9: stats(0.95, 3.3, 176), 0.8: stats(0.95, 3.3, 150) },
      noise: null,
    });
    expect(patch.lengthScale).toBe(1.2); // x0.8
  });

  it("keeps the pace when nothing reaches 90% exact, and lowers the speed-up when fast delivery is misheard", () => {
    const r = recommend(current, {
      sub: { 1: stats(0.85, 3.1, 170), 0.9: stats(0.8, 3.1, 185) },
      full: { 1: stats(0.85, 3.1, 170), 0.9: stats(0.8, 3.1, 185), 0.8: stats(0.7, 3.1, 205) },
      noise: null,
    });
    expect(r.patch.lengthScale).toBeUndefined();
    expect(r.patch.maxSpeedUp).toBe(0);
  });

  it("narrower rhythm noise only when the quality score gains at least 0.1 without losing exactness", () => {
    const base = { sub: { 1: stats(0.95, 3.0, 170) }, full: { 1: stats(0.95, 3.0, 170) } };
    expect(recommend(current, { ...base, noise: stats(0.95, 3.15, 170) }).patch.noiseWScale).toBe(0.5);
    expect(recommend(current, { ...base, noise: stats(0.9, 3.5, 170) }).patch.noiseWScale).toBeUndefined();
    expect(recommend(current, { ...base, noise: stats(0.95, 3.05, 170) }).patch.noiseWScale).toBeUndefined();
  });
});
