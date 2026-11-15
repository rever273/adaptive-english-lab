import { readFileSync } from "node:fs";
import path from "node:path";
import { PhoneticModel, TransitionTable, unscrambleWord } from "./phonetic.js";

export interface KeyData {
  model: PhoneticModel;
  /** a–z, most frequent first in English */
  lettersByFrequency: string[];
  /** real English words, most frequent first (scripts/typing-build-wordlist.mjs) */
  words: string[];
  wordSet: Set<string>;
}

let cached: { root: string; data: KeyData } | null = null;

/** Loads content/typing (keybr model, blacklist, word list) once per process. */
export function loadKeyData(projectRoot: string): KeyData {
  if (cached?.root === projectRoot) return cached.data;
  const dir = path.join(projectRoot, "content", "typing");
  const blacklist = new Set((JSON.parse(readFileSync(path.join(dir, "keybr", "blacklist-en.json"), "utf8")) as string[]).map(unscrambleWord));
  const model = new PhoneticModel(TransitionTable.load(readFileSync(path.join(dir, "keybr", "model-en.data"))), blacklist);
  const words = readFileSync(path.join(dir, "words-en.txt"), "utf8").split(/\r?\n/).filter(Boolean);
  const data: KeyData = {
    model,
    lettersByFrequency: model.letterFrequencies().map((l) => l.letter).filter((l) => /^[a-z]$/.test(l)),
    words,
    wordSet: new Set(words),
  };
  cached = { root: projectRoot, data };
  return data;
}
