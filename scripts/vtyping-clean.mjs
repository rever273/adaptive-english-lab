// npm run vtyping:clean [-- --dry-run (default) | --apply] [--limit N] [--from-rank A --to-rank B | --ranges 1-200,5000-5200]
//                       [--resume <run>] [--adopt <dry run>] [--revert <run>] [--model gemma4:12b] [--endpoint http://127.0.0.1:11434]
// Vocabulary Typing (D165): the local model advises which entries of the dictionary are useful words (keep / exclude / needs_review) and may refine the
// Russian translation. Nothing is deleted. Dry-run (the default) writes only var/vocab-typing/clean/<run>/;
// --apply makes a backup, appends the decisions to vocab_typing_cleanup (one transaction per batch), updates vocab_typing_lexicon, writes refined translations into typing_word_bank and ARCHIVES excluded words (D184). --revert only explains how to go back (npm run restore).
// The script needs the app STOPPED (npm run stop): it must not use the GPU next to the application's single dispatcher.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadServerModule, projectRoot, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const flag = (n) => args.includes(n);

const { loadConfig } = await loadServerModule("config.js");
const { readLock, classifyLock } = await loadServerModule("lock.js");
const { openDatabase } = await loadServerModule("db/open.js");
const { OllamaClient } = await loadServerModule("adapters/gpu/ollamaClient.js");
const { OllamaChatClient } = await loadServerModule("adapters/ollama/chat.js");
const { LOCAL_MODEL_TAG } = await loadServerModule("domain/ai/config.js");
const clean = await loadServerModule("domain/vocabTyping/clean.js");
const { createBackup, verifyBackup } = await loadServerModule("db/backup.js");
const { currentSchemaVersion } = await loadServerModule("db/migrate.js");

const config = loadConfig();
const apply = flag("--apply");
if (apply && flag("--dry-run")) {
  console.error("choose --dry-run or --apply, not both");
  process.exit(2);
}
const lock = readLock(config.lockPath);
if (lock && classifyLock(lock) !== "stale") {
  console.error(`English Lab is running (pid ${lock.pid}). Stop it first (npm run stop): the cleanup uses the local model and must not compete with the application's GPU dispatcher.`);
  process.exit(3);
}
const deps = { now: () => new Date(), newId: () => randomUUID() };
const dbFile = path.resolve(config.dbPath);
if (!existsSync(dbFile)) {
  console.error(`database not found: ${dbFile}`);
  process.exit(2);
}
const db = openDatabase(dbFile);

try {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name = 'vocab_typing_lexicon'").get() || db.prepare("SELECT COUNT(*) AS n FROM vocab_typing_lexicon").get().n === 0) {
    console.error("the lexicon is empty: apply migration 061 and run npm run vtyping:prepare first");
    process.exit(2);
  }

  if (opt("--revert")) {
    if (!apply) {
      console.error("--revert changes the database: add --apply");
      process.exit(2);
    }
    // the folder id printed by the script (one folder may hold several database runs after --resume) or a database run id
    const arg = opt("--revert");
    const saved = path.join(projectRoot, "var", "vocab-typing", "clean", arg, "run.json");
    const ids = existsSync(saved) ? (JSON.parse(readFileSync(saved, "utf8")).dbRunIds ?? []) : [arg];
    if (ids.length === 0) {
      console.error(`run ${arg} was a dry run: nothing to revert`);
      process.exit(2);
    }
    // an applied run changed translations in the word bank: there is no word-by-word undo (D175); the error says how to go back
    try {
      for (const id of [...ids].reverse()) clean.revertRun(db, deps, id);
    } catch (e) {
      console.error(e.message);
      process.exit(2);
    }
    process.exit(0);
  }

  const model = opt("--model", LOCAL_MODEL_TAG);
  const endpoint = opt("--endpoint", "http://127.0.0.1:11434");
  const runRoot = path.join(projectRoot, "var", "vocab-typing", "clean");
  let params;
  let runId;
  if (opt("--resume")) {
    runId = opt("--resume");
    const saved = path.join(runRoot, runId, "run.json");
    if (!existsSync(saved)) {
      console.error(`unknown run: ${saved}`);
      process.exit(2);
    }
    params = JSON.parse(readFileSync(saved, "utf8")).params;
    // the words a dry run already decided would be skipped and never reach the database
    if (!!params.apply !== apply) {
      console.error(`run ${runId} was ${params.apply ? "--apply" : "a dry run"}: resume it in the same mode (start a new --apply run instead)`);
      process.exit(2);
    }
  } else {
    const limit = Number(opt("--limit", "0")) || null;
    const ranges = opt("--ranges")
      ? opt("--ranges").split(",").map((r) => r.split("-").map(Number))
      : [[Number(opt("--from-rank", "1")), Number(opt("--to-rank", "1000000"))]];
    if (ranges.some((r) => r.length !== 2 || !(r[0] >= 1) || !(r[1] >= r[0]))) {
      console.error("bad rank range");
      process.exit(2);
    }
    params = { limit, ranges, apply };
    runId = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomUUID().slice(0, 6)}`;
  }

  // the words of the selection that still have no valid decision in this run
  const rows = [];
  for (const [from, to] of params.ranges) {
    const part = db
      .prepare("SELECT b.lemma, b.part_of_speech AS pos, COALESCE(l.primary_translation_ru, b.translation_ru) AS translationRu, b.definition_ru AS definitionRu, b.transcription, l.freq_rank AS rank FROM typing_word_bank b JOIN vocab_typing_lexicon l ON l.lemma = b.lemma WHERE l.eligibility = 'unreviewed' AND l.freq_rank BETWEEN ? AND ? ORDER BY l.freq_rank")
      .all(from, to);
    // a limit over several ranges takes an even share of each, spread over the range (every k-th word), so the sample is mixed and repeatable
    const share = params.limit ? Math.ceil(params.limit / params.ranges.length) : part.length;
    const step = Math.max(1, Math.floor(part.length / Math.max(1, share)));
    rows.push(...part.filter((_, i) => i % step === 0).slice(0, share));
  }
  const selected = params.limit ? rows.slice(0, params.limit) : rows;
  const dir = path.join(runRoot, runId);
  mkdirSync(dir, { recursive: true });
  const decisionsFile = path.join(dir, "decisions.jsonl");
  const errorsFile = path.join(dir, "errors.jsonl");
  const readDecisions = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);
  let done = new Set(readDecisions(decisionsFile).map((d) => d.lemma));
  let todo = selected.filter((w) => !done.has(w.lemma));
  let skipped = selected.length - todo.length;
  if (apply) {
    // the cleanup rewrites translations in the word bank: the old ones exist only in this backup (npm run restore brings them back)
    const manifest = await createBackup(db, { backupsDir: config.backupsDir, kind: "manual", schemaVersion: currentSchemaVersion(db), appVersion: config.appVersion });
    const check = verifyBackup(config.backupsDir, manifest);
    if (!check.checksumOk || check.integrity !== "ok") {
      console.error("the backup before the cleanup did not verify; nothing was changed");
      process.exit(2);
    }
    console.log(`backup before apply: ${manifest.file}`);
  }
  const dbRun = apply ? clean.startRun(db, deps, { mode: "apply", params, model }) : null;
  // --adopt <dry run>: the decisions a finished or interrupted dry run already made are written to the database now (same model and prompt version
  // required), so only the words it never reached go to the model
  if (opt("--adopt")) {
    if (!apply || opt("--resume")) {
      console.error("--adopt needs --apply and a new run (not --resume)");
      process.exit(2);
    }
    const from = path.join(runRoot, opt("--adopt"));
    const meta = existsSync(path.join(from, "run.json")) ? JSON.parse(readFileSync(path.join(from, "run.json"), "utf8")) : null;
    if (!meta || meta.params.apply || meta.model !== model || meta.promptVersion !== clean.CLEAN_PROMPT_VERSION) {
      console.error(`--adopt: ${opt("--adopt")} must be a dry run made with the same model (${model}) and prompt version (${clean.CLEAN_PROMPT_VERSION})`);
      process.exit(2);
    }
    const wanted = new Set(todo.map((w) => w.lemma));
    const seen = new Set();
    const adopt = readDecisions(path.join(from, "decisions.jsonl")).filter((d) => wanted.has(d.lemma) && !seen.has(d.lemma) && seen.add(d.lemma));
    for (let i = 0; i < adopt.length; i += clean.BATCH_SIZE) {
      const part = adopt.slice(i, i + clean.BATCH_SIZE);
      clean.applyDecisions(db, deps, dbRun, model, part);
      for (const d of part) appendFileSync(decisionsFile, `${JSON.stringify(d)}\n`);
    }
    console.log(`adopted ${adopt.length} decisions of the dry run ${opt("--adopt")}; ${wanted.size - adopt.length} words still need the model`);
    done = new Set(readDecisions(decisionsFile).map((d) => d.lemma));
    todo = selected.filter((w) => !done.has(w.lemma));
    skipped = selected.length - todo.length;
  }
  const runFile = path.join(dir, "run.json");
  const earlier = existsSync(runFile) ? JSON.parse(readFileSync(runFile, "utf8")) : null;
  const dbRunIds = [...(earlier?.dbRunIds ?? []), ...(dbRun ? [dbRun] : [])];
  writeFileSync(runFile, JSON.stringify({ runId, params, model, promptVersion: clean.CLEAN_PROMPT_VERSION, startedAt: earlier?.startedAt ?? new Date().toISOString(), dbRunIds }, null, 2));
  const chat = new OllamaChatClient(new OllamaClient({ baseUrl: endpoint }), 240_000);
  const totals = { total: selected.length, keep: 0, exclude: 0, needs_review: 0, softened: 0, translationChanged: 0, transcriptionDoubt: 0, errors: 0, skipped };
  const byCode = {};
  const started = Date.now();
  const batches = Math.ceil(todo.length / clean.BATCH_SIZE);
  const clock = (sec) => {
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s % 60).padStart(2, "0")}s`;
  };
  const at = (d) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  console.log(`run ${runId}: ${todo.length} words to process in ${batches} batches of ${clean.BATCH_SIZE}${skipped ? ` (${skipped} already done in this run)` : ""}; ${apply ? "APPLY" : "dry run"}, model ${model}`);
  /** one line per batch: position, share done, decisions so far, elapsed time and the remaining time from the average speed so far */
  const progress = (n, note) => {
    const elapsed = (Date.now() - started) / 1000;
    const left = batches - n;
    const eta = left > 0 ? (elapsed / n) * left : 0;
    const pct = ((n / batches) * 100).toFixed(1);
    console.log(`[${String(n).padStart(String(batches).length)}/${batches} ${pct.padStart(5)}%] ${note} | keep ${totals.keep} · exclude ${totals.exclude} · review ${totals.needs_review} · errors ${totals.errors} | ${clock(elapsed)} elapsed, ~${clock(eta)} left (${left} batches, done ≈ ${at(new Date(Date.now() + eta * 1000))})`);
  };
  for (let i = 0; i < todo.length; i += clean.BATCH_SIZE) {
    const batch = todo.slice(i, i + clean.BATCH_SIZE).map((w, k) => ({ ...w, wordId: k + 1 }));
    const r = await clean.cleanBatch(chat, model, batch).catch((e) => ({ ok: false, code: `exception:${e.message}` }));
    if (!r.ok) {
      for (const w of batch) {
        appendFileSync(errorsFile, `${JSON.stringify({ lemma: w.lemma, code: r.code })}\n`);
        byCode[r.code] = (byCode[r.code] ?? 0) + 1;
      }
      totals.errors += batch.length;
      progress(i / clean.BATCH_SIZE + 1, `failed (${r.code}), retry later with --resume ${runId}`);
      continue;
    }
    for (const e of r.result.errors) {
      appendFileSync(errorsFile, `${JSON.stringify(e)}\n`);
      byCode[e.code] = (byCode[e.code] ?? 0) + 1;
      totals.errors++;
    }
    for (const d of r.result.decisions) {
      appendFileSync(decisionsFile, `${JSON.stringify(d)}\n`);
      totals[d.decision]++;
      if (d.softened) totals.softened++;
      if (d.primaryTranslationRu) totals.translationChanged++;
      if (d.transcriptionDoubt) totals.transcriptionDoubt++;
    }
    if (dbRun) clean.applyDecisions(db, deps, dbRun, model, r.result.decisions);
    progress(i / clean.BATCH_SIZE + 1, `${r.result.decisions.length} decided${r.result.errors.length ? `, ${r.result.errors.length} to retry` : ""}`);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const processed = todo.length - totals.errors;
  const perWord = processed > 0 ? seconds / processed : null;
  if (dbRun) clean.finishRun(db, deps, dbRun, totals);
  const report = [
    `# Dictionary cleanup ${apply ? "(applied)" : "(dry run)"}: ${runId}`,
    "",
    `Model: ${model}; prompt ${clean.CLEAN_PROMPT_VERSION}; ranges ${JSON.stringify(params.ranges)}; limit ${params.limit ?? "none"}.`,
    "",
    `- selected: ${totals.total} (already decided in this run: ${totals.skipped})`,
    `- keep: ${totals.keep}, exclude: ${totals.exclude}, needs_review: ${totals.needs_review} (of them softened from exclude: ${totals.softened})`,
    `- translation changed: ${totals.translationChanged}; transcription doubted: ${totals.transcriptionDoubt}`,
    `- errors (retried by --resume ${runId}): ${totals.errors} ${Object.keys(byCode).length ? JSON.stringify(byCode) : ""}`,
    `- time: ${seconds} s${perWord === null ? "" : `, about ${perWord.toFixed(2)} s per word`}`,
    perWord === null ? "" : `- whole dictionary (about 20,000 words): about ${((perWord * 20000) / 3600).toFixed(1)} hours`,
    "",
  ].join("\n");
  writeFileSync(path.join(dir, "report.md"), report);
  console.log(report);
  console.log(`files: ${dir}`);
  // free the GPU the model used
  await new OllamaClient({ baseUrl: endpoint }).json("/api/generate", { body: { model, keep_alive: 0 }, timeoutMs: 20_000 }).catch(() => {});
} finally {
  db.close();
}
