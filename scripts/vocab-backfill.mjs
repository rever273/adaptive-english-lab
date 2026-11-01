// npm run vocab:backfill [-- --db <sqlite file>]
// Queues one background job (the local model, through the single GPU dispatcher) for every saved word that still lacks a CEFR level or the
// reference facts of D69 (transcription, Russian definition, synonyms, irregular forms). Idempotent: a word that already has a queued or finished
// job is skipped, and the job never touches a translation or anything the learner wrote. Safe while the app runs: the running server's scheduler
// picks the queued jobs up by itself; if the app is stopped they run at its next start (the same queueing also happens at every start).
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadServerModule, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const { loadConfig } = await loadServerModule("config.js");
const { openDatabase } = await loadServerModule("db/open.js");
const { queueMissingLevels } = await loadServerModule("domain/vocabulary/repository.js");
const config = loadConfig();
const dbFile = path.resolve(opt("--db") ?? config.dbPath);
if (!existsSync(dbFile)) {
  console.error(`database not found: ${dbFile}`);
  process.exit(2);
}
const db = openDatabase(dbFile);
try {
  const visible = "(SELECT kind FROM vocabulary_entry_events ev WHERE ev.entry_id = e.id ORDER BY ev.created_at DESC, ev.rowid DESC LIMIT 1) IS NOT 'removed'";
  const count = (extra) => db.prepare(`SELECT COUNT(*) AS n FROM vocabulary_entries e WHERE ${visible} ${extra}`).get().n;
  const total = count("");
  const missingBefore = count("AND NOT EXISTS (SELECT 1 FROM vocabulary_lexicon x WHERE x.entry_id = e.id)");
  const queued = queueMissingLevels(db, { now: () => new Date(), newId: randomUUID });
  console.log(JSON.stringify({ words: total, withoutReferenceFacts: missingBefore, jobsQueued: queued, note: queued > 0 ? "The local model fills them in the background (watch AI Tasks)." : "Nothing new to queue." }, null, 2));
} finally {
  db.close();
}
