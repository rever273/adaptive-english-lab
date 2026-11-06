import { describe, expect, it } from "vitest";
import { sampleStats } from "../../../apps/server/src/domain/voices/sampleStats.js";

function wav(samples: number[], rate = 22050): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => buf.writeInt16LE(v, 44 + i * 2));
  return buf;
}
const tone = (s: number) => Array.from({ length: Math.round(s * 22050) }, (_, i) => Math.round(8000 * Math.sin(i / 8)));
const quiet = (s: number) => new Array<number>(Math.round(s * 22050)).fill(0);

describe("sample speed", () => {
  it("counts only the audible part: 10 words and 14 syllables in 2 s", () => {
    const s = sampleStats(wav([...quiet(0.4), ...tone(2), ...quiet(0.6)]), 10, 14)!;
    expect(s.speechSeconds).toBeCloseTo(2, 1);
    expect(s.wordsPerMinute).toBeCloseTo(300, -1);
    expect(s.syllablesPerSecond).toBeCloseTo(7, 0);
  });

  it("is null for bytes that are not a 16-bit WAV or have no sound", () => {
    expect(sampleStats(Buffer.from("RIFF-sample"), 10, 14)).toBeNull();
    expect(sampleStats(wav(quiet(1)), 10, 14)).toBeNull();
  });
});
