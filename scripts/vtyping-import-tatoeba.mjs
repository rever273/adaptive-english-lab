// npm run vtyping:import-tatoeba [-- --download] [-- --dir var/reference/tatoeba] [-- --db <sqlite file>]
// Vocabulary Typing (D166): imports the best example sentences (English + one Russian translation) of the Tatoeba corpus for every word of the pool.
// --download fetches the per-language exports once into the git-ignored directory (default var/reference/tatoeba); without it the files must be there.
// The .bz2 files are untrusted data: they are decompressed by scripts/vtyping-bunzip.py (Python standard library, isolated mode) into plain .tsv files and only read.
// Needs `npm run vtyping:prepare` first. Importing the same version again changes nothing. Licence: CC BY 2.0 FR (CC0 where Tatoeba lists the sentence as CC0).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { loadServerModule, projectRoot, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const dir = path.resolve(projectRoot, opt("--dir", path.join("var", "reference", "tatoeba")));
const BASE = "https://downloads.tatoeba.org/exports/per_language";
const FILES = [
  { key: "engSentences", name: "eng_sentences_detailed.tsv", url: `${BASE}/eng/eng_sentences_detailed.tsv.bz2` },
  { key: "rusSentences", name: "rus_sentences_detailed.tsv", url: `${BASE}/rus/rus_sentences_detailed.tsv.bz2` },
  { key: "links", name: "eng-rus_links.tsv", url: `${BASE}/eng/eng-rus_links.tsv.bz2` },
  { key: "engCc0", name: "eng_sentences_CC0.tsv", url: `${BASE}/eng/eng_sentences_CC0.tsv.bz2` },
  { key: "rusCc0", name: "rus_sentences_CC0.tsv", url: `${BASE}/rus/rus_sentences_CC0.tsv.bz2` },
];

const sha256 = async (file) => {
  const h = createHash("sha256");
  await pipeline(createReadStream(file), h);
  return h.digest("hex");
};

mkdirSync(dir, { recursive: true });
const meta = {};
for (const f of FILES) {
  const bz2 = path.join(dir, `${f.name}.bz2`);
  if (!existsSync(bz2)) {
    if (!args.includes("--download")) {
      console.error(`missing ${bz2}: run with --download once`);
      process.exit(2);
    }
    console.log(`downloading ${f.url}`);
    const res = await fetch(f.url);
    if (!res.ok || !res.body) {
      console.error(`download failed: ${res.status} ${f.url}`);
      process.exit(2);
    }
    await pipeline(Readable.fromWeb(res.body), createWriteStream(bz2));
    meta[f.name] = { exportDate: res.headers.get("last-modified") };
  }
  const plain = path.join(dir, f.name);
  if (!existsSync(plain) || statSync(plain).mtimeMs < statSync(bz2).mtimeMs) {
    const r = spawnSync("py", ["-3.11", "-I", path.join(projectRoot, "scripts", "vtyping-bunzip.py"), bz2, plain], { encoding: "utf8" });
    if (r.status !== 0) {
      console.error(`could not decompress ${bz2}: ${r.stderr || r.stdout}`);
      process.exit(2);
    }
  }
}
const metaFile = path.join(dir, "meta.json");
const saved = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : {};
Object.assign(saved, meta);
writeFileSync(metaFile, JSON.stringify(saved, null, 2));

const inputs = { files: [] };
let downloadedBytes = 0;
for (const f of FILES) {
  const bz2 = path.join(dir, `${f.name}.bz2`);
  const bytes = statSync(bz2).size;
  downloadedBytes += bytes;
  inputs.files.push({ name: f.name, bytes, sha256: await sha256(bz2), exportDate: saved[f.name]?.exportDate ?? null });
}

const { loadConfig } = await loadServerModule("config.js");
const { openDatabase } = await loadServerModule("db/open.js");
const { importTatoeba } = await loadServerModule("domain/vocabTyping/tatoeba.js");
const config = loadConfig();
const dbFile = path.resolve(opt("--db", config.dbPath));
if (!existsSync(dbFile)) {
  console.error(`database not found: ${dbFile}`);
  process.exit(2);
}
const unscramble = (w) => {
  const a = [...w];
  return a.map((_, i) => a[(23 * i + 13) % a.length]).join("");
};
const blacklist = new Set(JSON.parse(readFileSync(path.join(projectRoot, "content", "typing", "keybr", "blacklist-en.json"), "utf8")).map(unscramble));

const db = openDatabase(dbFile);
try {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name = 'vocab_typing_lexicon'").get()) {
    console.error("vocab_typing_lexicon is missing: apply migration 061 first (start the app once)");
    process.exit(2);
  }
  if ((db.prepare("SELECT COUNT(*) AS n FROM vocab_typing_lexicon").get().n) === 0) {
    console.error("the word ranks are missing: run npm run vtyping:prepare first");
    process.exit(2);
  }
  const sizeBefore = statSync(dbFile).size;
  const paths = Object.fromEntries(FILES.map((f) => [f.key, path.join(dir, f.name)]));
  const report = await importTatoeba(db, paths, inputs, blacklist, { now: () => new Date(), newId: () => crypto.randomUUID() }, (m) => console.log(m));
  db.pragma("wal_checkpoint(TRUNCATE)");
  const sizeAfter = statSync(dbFile).size;
  const out = { ...report, downloadedBytes, dbBytesBefore: sizeBefore, dbBytesAfter: sizeAfter, dbGrowthBytes: sizeAfter - sizeBefore };
  const reportDir = path.join(projectRoot, "var", "vocab-typing");
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(path.join(reportDir, "tatoeba-import-report.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ...out, coverage: undefined }, null, 2));
  console.log("coverage by band (lemmas, >=3, 1-2, 0):");
  for (const b of report.coverage) console.log(`  band ${b.band}: ${b.lemmas}, ${b.atLeast3}, ${b.oneOrTwo}, ${b.none}`);
} finally {
  db.close();
}
