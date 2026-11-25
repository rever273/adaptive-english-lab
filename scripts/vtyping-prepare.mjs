// npm run vtyping:prepare [-- --csv <file>] [-- --db <sqlite file>]
// Vocabulary Typing (D164): gives every typing_word_bank lemma its frequency rank (the `id` of its row in the learner's CSV, which is ordered by
// frequency) and band in vocab_typing_lexicon. Idempotent; never changes typing_word_bank or any cleanup decision. No network, no model.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadServerModule, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const { loadConfig } = await loadServerModule("config.js");
const { openDatabase } = await loadServerModule("db/open.js");
const { prepareLexicon } = await loadServerModule("domain/vocabTyping/lexicon.js");

const config = loadConfig();
const csvFile = opt("--csv") ?? config.lexiconCsv;
if (!csvFile || !existsSync(csvFile)) {
  console.error("No CSV source: pass --csv <file> or set lexiconCsv in englishlab.local.json");
  process.exit(2);
}
const dbFile = path.resolve(opt("--db") ?? config.dbPath);
if (!existsSync(dbFile)) {
  console.error(`database not found: ${dbFile} (start the app once to apply migrations)`);
  process.exit(2);
}
const db = openDatabase(dbFile);
try {
  const ok = db.prepare("SELECT name FROM sqlite_master WHERE name IN ('vocab_typing_lexicon','typing_word_bank')").all().length === 2;
  if (!ok) {
    console.error("vocab_typing_lexicon is missing: start the app once to apply migration 061");
    process.exit(2);
  }
  console.log(JSON.stringify(prepareLexicon(db, readFileSync(csvFile, "utf8"), new Date()), null, 2));
} finally {
  db.close();
}
