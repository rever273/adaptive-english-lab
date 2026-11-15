// npm run typing:build-wordlist
// Builds content/typing/words-en.txt for Key Builder: real English words (SCOWL/ESDB, Australian spelling, size 70) ranked by
// frequency (FrequencyWords, OpenSubtitles 2018). The two sources are downloaded once into var/reference/wordlists (git-ignored);
// only the derived list is published. Offensive words are dropped with keybr.com's English blacklist (content/typing/keybr/blacklist-en.json).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cache = path.join(root, "var", "reference", "wordlists");
const SOURCES = {
  "scowl-au-70.txt":
    "http://app.aspell.net/create?max_size=70&spelling=AU&max_variant=0&diacritic=strip&special=hacker&download=wordlist&encoding=utf-8&format=inline",
  "en_full.txt": "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_full.txt",
};
/** words seen fewer times than this in the subtitles corpus are mostly noise */
const MIN_COUNT = 20;
const MIN_LEN = 2;
const MAX_LEN = 14;
/** halves of contractions split by the subtitles tokenizer ("don't" -> "don"), not words on their own here */
const EXCLUDE = new Set(["don", "ain", "didn", "doesn", "isn", "wasn", "couldn", "shouldn", "wouldn", "hasn", "haven", "aren", "weren", "hadn", "mustn", "needn"]);

async function source(name) {
  const file = path.join(cache, name);
  if (!existsSync(file)) {
    mkdirSync(cache, { recursive: true });
    const res = await fetch(SOURCES[name]);
    if (!res.ok) throw new Error(`download failed: ${name} ${res.status}`);
    writeFileSync(file, await res.text());
  }
  return readFileSync(file, "utf8");
}

// keybr.com stores its blacklist scrambled (packages/keybr-phonetic-model/lib/blacklist/scramble.ts)
const unscramble = (w) => {
  const a = [...w];
  return a.map((_, i) => a[(23 * i + 13) % a.length]).join("");
};

const scowlText = await source("scowl-au-70.txt");
const body = scowlText.slice(scowlText.indexOf("---") + 3);
const valid = new Set(body.split(/\r?\n/).filter((w) => /^[a-z]+$/.test(w)));
const blacklist = new Set(JSON.parse(readFileSync(path.join(root, "content", "typing", "keybr", "blacklist-en.json"), "utf8")).map(unscramble));

const words = [];
const seen = new Set();
for (const line of (await source("en_full.txt")).split(/\r?\n/)) {
  const [word, n] = line.split(" ");
  const count = Number(n);
  if (!word || !(count >= MIN_COUNT)) continue;
  if (word.length < MIN_LEN || word.length > MAX_LEN || !valid.has(word) || blacklist.has(word) || seen.has(word) || EXCLUDE.has(word)) continue;
  seen.add(word);
  words.push(word);
}

const out = path.join(root, "content", "typing", "words-en.txt");
writeFileSync(out, words.join("\n") + "\n");
console.log(`words-en.txt: ${words.length} words (of ${valid.size} SCOWL words), most frequent first`);
