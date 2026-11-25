/**
 * Key Builder text: keybr's guided text (only open letters, every word with the focused letter; keybr-lesson/lib/guided.ts
 * generate()) made of real English words from content/typing/words-en.txt mixed with keybr pseudo-words. Pseudo-words train
 * letter sequences; they are marked as such, never shown with a translation and never counted as words of the vocabulary.
 */
import { randomSample, type KeyFilter, type PhoneticModel, type Rng } from "./phonetic.js";

export interface KeyToken {
  text: string;
  kind: "word" | "pseudo";
}

/**
 * keybr takes only the first 1000 dictionary words that fit; here every word of the list may come. COMMON_SHARE of the real words are
 * picked from the COMMON_TOP most frequent fitting words (the words worth knowing), the rest from all fitting words.
 */
export const COMMON_SHARE = 0.7;
export const COMMON_TOP = 3000;
/** pseudo-words take this share of the text while only a few real words fit, down to MIN_PSEUDO_SHARE once many do */
export const MAX_PSEUDO_SHARE = 0.5;
export const MIN_PSEUDO_SHARE = 0.2;
/** real words that fit the open letters at which the pseudo share reaches its minimum */
export const RICH_POOL = 1500;
export const MIN_WORD_LEN = 3;

/** longest real word allowed: short words while few letters are open, then longer */
export const maxWordLength = (openKeys: number): number => Math.min(14, 4 + Math.floor(openKeys / 3));

export function pseudoShare(poolSize: number): number {
  const t = Math.min(1, poolSize / RICH_POOL);
  return Math.round((MAX_PSEUDO_SHARE - (MAX_PSEUDO_SHARE - MIN_PSEUDO_SHARE) * t) * 100) / 100;
}

/** real words (most frequent first) made only of open letters and containing the focused one, within the length limit */
export function realWordPool(words: readonly string[], filter: KeyFilter): string[] {
  const maxLen = maxWordLength(filter.letters.size);
  const pool: string[] = [];
  for (const w of words) {
    if (w.length < MIN_WORD_LEN || w.length > maxLen) continue;
    if (filter.focused && !w.includes(filter.focused)) continue;
    let ok = true;
    for (const ch of w) if (!filter.letters.has(ch)) { ok = false; break; }
    if (!ok) continue;
    pool.push(w);
  }
  return pool;
}

/** `count` tokens; never the same text twice in a row (keybr uniqueWords) */
export function keyLessonText(words: readonly string[], wordSet: ReadonlySet<string>, model: PhoneticModel, filter: KeyFilter, count: number, random: Rng): KeyToken[] {
  const pool = realWordPool(words, filter);
  const common = pool.slice(0, COMMON_TOP);
  // keybr pads a pool of fewer than 15 real words with pseudo-words; here a small pool simply means mostly pseudo-words
  const share = pool.length < 15 ? Math.max(pseudoShare(pool.length), 1 - pool.length / 15) : pseudoShare(pool.length);
  const out: KeyToken[] = [];
  let last = "";
  for (let guard = 0; out.length < count && guard < count * 20; guard++) {
    const pseudo = pool.length === 0 || random() < share;
    const text = pseudo ? model.nextWord(filter, random) : randomSample(random() < COMMON_SHARE ? common : pool, random);
    if (!text || text === last) continue;
    last = text;
    // a generated string that happens to be a real word is a real word
    out.push({ text, kind: pseudo && !wordSet.has(text) ? "pseudo" : "word" });
  }
  return out;
}
