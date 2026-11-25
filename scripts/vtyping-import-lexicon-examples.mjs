// npm run vtyping:import-lexicon-examples [-- --csv <file>] [-- --db <sqlite file>]
// Vocabulary Typing (D179): adds every "Example sentence N / Example translation N" pair of the learner's own CSV as source 'lexicon', through the same code
// checks as the Tatoeba import. Needs migration 062 and `npm run vtyping:prepare`. Importing the same CSV again changes nothing.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadServerModule, projectRoot, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const { loadConfig } = await loadServerModule("config.js");
const { openDatabase } = await loadServerModule("db/open.js");
const { importLexiconExamples } = await loadServerModule("domain/vocabTyping/lexiconExamples.js");
const config = loadConfig();
const csvFile = opt("--csv") ?? config.lexiconCsv;
if (!csvFile || !existsSync(csvFile)) {
  console.error("No CSV source: pass --csv <file> or set lexiconCsv in englishlab.local.json");
  process.exit(2);
}
const dbFile = path.resolve(opt("--db") ?? config.dbPath);
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
  const cols = db.prepare("PRAGMA table_info(typing_word_bank)").all().map((c) => c.name);
  if (!cols.includes("archived") || !db.prepare("SELECT COUNT(*) AS n FROM vocab_typing_lexicon").get().n) {
    console.error("apply migration 062 (start the app once) and run npm run vtyping:prepare first");
    process.exit(2);
  }
  const before = statSync(dbFile).size;
  const r = importLexiconExamples(db, readFileSync(csvFile, "utf8"), blacklist, { now: () => new Date(), newId: () => randomUUID() }, (m) => console.log(m));
  db.pragma("wal_checkpoint(TRUNCATE)");
  const out = { ...r, dbGrowthBytes: statSync(dbFile).size - before };
  mkdirSync(path.join(projectRoot, "var", "vocab-typing"), { recursive: true });
  writeFileSync(path.join(projectRoot, "var", "vocab-typing", "lexicon-examples-report.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ...out, coverage: undefined }, null, 2));
  console.log("coverage by band (lemmas, >=3, 1-2, 0):");
  for (const b of r.coverage) console.log(`  band ${b.band}: ${b.lemmas}, ${b.atLeast3}, ${b.oneOrTwo}, ${b.none}`);
} finally {
  db.close();
}
