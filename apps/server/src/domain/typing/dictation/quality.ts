import { tokenize } from "./check.js";

export const SENTENCE_RULES = { minWords: 6, maxWords: 15, maxTranslationChars: 300 } as const;
const ALLOWED = /^[A-Za-z ,.'?!-]+$/;
const ENDS = /[.?!]$/;
const ACRONYM = /\b[A-Z]{2,}\b/;
const CYRILLIC = /\p{Script=Cyrillic}/u;
// homophones that cannot be told apart by ear (apostrophes are removed by tokenize)
const BANNED_WORDS = new Set(["their", "there", "theyre", "hes"]);

export type SentenceIssue = "WORD_COUNT" | "NOT_ENDED" | "CHARS" | "ACRONYM" | "NAMES" | "HOMOPHONE" | "CYRILLIC_IN_ENGLISH" | "TRANSLATION";
export type RejectCode = SentenceIssue | "DUPLICATE" | "SAME_AS_BANK" | "NEAR_DUPLICATE" | "WORD_MISSING" | "TOPIC_NAME" | "OPENING_REPEAT" | "ASR_MISMATCH" | "SENTENCE_DROPPED" | "WAV_INVALID" | "WAV_LENGTH";

/** Code checks a model sentence must pass before it is voiced. Returns the first reason, or null. Duplicates are checked against the database elsewhere. */
export function checkSentence(textEn: string, translationRu: string): SentenceIssue | null {
  const text = textEn.replace(/[‘’]/g, "'").trim();
  if (CYRILLIC.test(text)) return "CYRILLIC_IN_ENGLISH";
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < SENTENCE_RULES.minWords || words.length > SENTENCE_RULES.maxWords) return "WORD_COUNT";
  if (!ENDS.test(text)) return "NOT_ENDED";
  if (!ALLOWED.test(text)) return "CHARS";
  if (ACRONYM.test(text)) return "ACRONYM";
  // a name that is not at the start of the sentence is hard to spell from sound (a single place name is tolerated)
  const capitals = words.slice(1).filter((w) => /^[A-Z]/.test(w) && !/^I(?:'|\W|$)/.test(w));
  if (capitals.length > 1) return "NAMES";
  if (tokenize(text).some((t) => BANNED_WORDS.has(t))) return "HOMOPHONE";
  const tr = translationRu.trim();
  if (tr.length === 0 || tr.length > SENTENCE_RULES.maxTranslationChars || !CYRILLIC.test(tr)) return "TRANSLATION";
  return null;
}

/** A WAV is plausible when it is a RIFF file and the speech length per word is within a loose human range (a crude guard against cut-off speech). */
export const WAV_MS_PER_WORD = { min: 150, max: 700 } as const;
export const TAIL_SILENCE_MS = 150;

interface Pcm {
  rate: number;
  dataStart: number;
  dataLength: number;
  samples: Int16Array;
}

function parsePcm(buf: Buffer): Pcm | null {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let p = 12;
  let rate = 22050;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === "fmt ") rate = buf.readUInt32LE(p + 12);
    if (id === "data") {
      const available = buf.length - (p + 8);
      const length = Math.min(size, available) - (Math.min(size, available) % 2);
      const copy = Buffer.from(buf.subarray(p + 8, p + 8 + length));
      return { rate, dataStart: p + 8, dataLength: length, samples: new Int16Array(copy.buffer, copy.byteOffset, length / 2) };
    }
    p += 8 + size + (size % 2);
  }
  return null;
}

export type WavCheck = { ok: true; wav: Buffer; audioMs: number } | { ok: false; code: "WAV_INVALID" | "WAV_LENGTH" };

/** Validates the WAV and makes sure it ends with at least TAIL_SILENCE_MS of silence (appended when short). */
export function checkWav(wav: Buffer, wordCount: number): WavCheck {
  const pcm = parsePcm(wav);
  if (!pcm || pcm.samples.length === 0) return { ok: false, code: "WAV_INVALID" };
  const peak = pcm.samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  if (peak === 0) return { ok: false, code: "WAV_INVALID" };
  const gate = Math.max(80, peak * 0.02);
  let last = pcm.samples.length - 1;
  while (last > 0 && Math.abs(pcm.samples[last]!) <= gate) last--;
  const tailMs = ((pcm.samples.length - 1 - last) / pcm.rate) * 1000;
  const speechMs = ((last + 1) / pcm.rate) * 1000;
  const perWord = speechMs / wordCount;
  if (perWord < WAV_MS_PER_WORD.min || perWord > WAV_MS_PER_WORD.max) return { ok: false, code: "WAV_LENGTH" };
  let out = wav;
  let samples = pcm.samples.length;
  if (tailMs < TAIL_SILENCE_MS) {
    const extra = Math.ceil(((TAIL_SILENCE_MS - tailMs) / 1000) * pcm.rate) * 2;
    const head = Buffer.from(wav.subarray(0, pcm.dataStart + pcm.dataLength));
    out = Buffer.concat([head, Buffer.alloc(extra)]);
    out.writeUInt32LE(pcm.dataLength + extra, pcm.dataStart - 4);
    out.writeUInt32LE(out.length - 8, 4);
    samples += extra / 2;
  }
  return { ok: true, wav: out, audioMs: Math.round((samples / pcm.rate) * 1000) };
}
