export interface SampleStats {
  /** from the first to the last audible moment, so the silence at the ends does not count */
  speechSeconds: number;
  wordsPerMinute: number;
  syllablesPerSecond: number;
}

/** 16-bit mono PCM samples of a WAV, or null when the bytes are not one */
function pcm16(wav: Buffer): { rate: number; samples: Int16Array } | null {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") return null;
  let rate = 0;
  for (let at = 12; at + 8 <= wav.length; ) {
    const id = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === "fmt " && at + 24 <= wav.length) {
      if (wav.readUInt16LE(at + 8 + 14) !== 16) return null;
      rate = wav.readUInt32LE(at + 8 + 4);
    }
    if (id === "data") {
      const end = Math.min(wav.length, at + 8 + size);
      const bytes = wav.subarray(at + 8, at + 8 + Math.floor((end - at - 8) / 2) * 2);
      const samples = new Int16Array(bytes.length / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2);
      return rate > 0 ? { rate, samples } : null;
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

/**
 * How fast a voice really speaks a phrase: words and syllables per second of audible speech. Syllables are the fairer measure for a short
 * phrase of short words, which "words a minute" makes look fast; the syllable count is given, not guessed.
 */
export function sampleStats(wav: Buffer, words: number, syllables: number): SampleStats | null {
  const audio = pcm16(wav);
  if (!audio || audio.samples.length === 0) return null;
  const win = Math.max(1, Math.round(audio.rate * 0.01));
  const rms: number[] = [];
  let peak = 0;
  for (const v of audio.samples) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i + win <= audio.samples.length; i += win) {
    let s = 0;
    for (let k = 0; k < win; k++) s += audio.samples[i + k]! ** 2;
    rms.push(Math.sqrt(s / win));
  }
  const gate = Math.max(80, peak * 0.02);
  const first = rms.findIndex((v) => v > gate);
  let last = rms.length - 1;
  while (last > 0 && rms[last]! <= gate) last--;
  if (first < 0 || last <= first) return null;
  const speechSeconds = (last - first + 1) * 0.01;
  return { speechSeconds: Math.round(speechSeconds * 100) / 100, wordsPerMinute: Math.round((words / speechSeconds) * 60), syllablesPerSecond: Math.round((syllables / speechSeconds) * 10) / 10 };
}
