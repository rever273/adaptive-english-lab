// Measures how useful the Nimble draft screen (D49) is as a HINT for the reviewer. REAL Nimble calls, one model, direct (no other GPU work).
// Sets: GOOD  = the 45 hand-written slice exercises (reviewed by an agent, not by a human),
//       BAD   = the Trial drafts that a reviewer rejected (generation-v1: 24, v2: 19, v3: 18) from the isolated trial profiles.
// It reports how often an item gets at least one hint, per set and per threshold pair. It does NOT claim the hints are right: the labels are
// an agent's review. Thresholds were chosen on generation-v1 (dev) and are judged on generation-v2/v3 (new data).
//   node scripts/advisory-eval.mjs [--v1 var/trial-generation-v1/db/trial.sqlite] [--v2 var/trial/db/trial.sqlite]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { loadServerModule, projectRoot, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const { OllamaClient, OllamaModelControl } = await loadServerModule("adapters/gpu/ollamaClient.js");
const { NimbleDecisionClient } = await loadServerModule("adapters/ollama/chat.js");
const { screenSentences, flagsFor } = await loadServerModule("domain/content/batches/screen.js");
const { DRAFT_SCREEN_V1 } = await loadServerModule("domain/ai/prompts.js");
const { buildSliceBank } = await import(new URL("../content/slice/slice-bank.mjs", import.meta.url));

const client = new OllamaClient();
const control = new OllamaModelControl(client);
const resident = await control.listLoaded();
if (resident === null || resident.length > 0) {
  console.error(`Refusing to run: Ollama unreachable or a model is resident (${JSON.stringify(resident)}).`);
  process.exit(2);
}
const decide = new NimbleDecisionClient(client);
const MODEL = "nimble-v3:latest";

const fromDb = (file) => {
  const db = new Database(path.resolve(file), { readonly: true });
  const rows = db.prepare("SELECT er.type AS type, er.content_json AS c, (SELECT verdict FROM content_reviews cr WHERE cr.revision_id = er.id ORDER BY cr.rowid DESC LIMIT 1) AS verdict FROM exercise_revisions er").all();
  db.close();
  return rows.map((r) => ({ type: r.type, content: JSON.parse(r.c), verdict: r.verdict }));
};
const sets = {
  good_slice45: buildSliceBank().map((c) => ({ type: c.type, content: c, verdict: "approved" })),
  gen_v1_dev: fromDb(arg("--v1", "var/trial-generation-v1/db/trial.sqlite")),
  gen_v2: fromDb(arg("--v2", "var/trial-generation-v2/db/trial.sqlite")),
  gen_v3_new: fromDb(arg("--v3", "var/trial/db/trial.sqlite")),
};

const score = async (text) => {
  const d = await decide.decide({ model: MODEL, text, instructions: DRAFT_SCREEN_V1.instructions, criteria: DRAFT_SCREEN_V1.criteria });
  return d.probabilities.review ?? (d.choice === "review" ? 1 : 0);
};
const out = { startedAt: new Date().toISOString(), model: MODEL, prompt: "draft-screen-v1", sets: {} };
for (const [name, items] of Object.entries(sets)) {
  const rows = [];
  for (const it of items) {
    const sents = screenSentences(it.type, it.content);
    const scores = [];
    for (const s of sents) scores.push(await score(s.text));
    rows.push({ type: it.type, verdict: it.verdict, sents, scores });
  }
  out.sets[name] = rows;
  console.log(name, rows.length, "items,", rows.reduce((a, r) => a + r.sents.length, 0), "sentences");
}
await control.unload(MODEL).catch(() => undefined);

const grid = [];
for (const k of [0.3, 0.5, 0.7]) for (const d of [0.02, 0.05, 0.1, 0.2]) grid.push({ keyWrongAtLeast: k, distractorOkBelow: d });
const flagged = (r, t) => flagsFor(r.sents, r.scores, t).length > 0;
const table = grid.map((t) => {
  const row = { ...t };
  for (const [name, rows] of Object.entries(out.sets)) {
    const bad = name === "good_slice45" ? null : rows.filter((r) => r.verdict !== "approved");
    row[name] = name === "good_slice45" ? `${rows.filter((r) => flagged(r, t)).length}/${rows.length} flagged (false alarms)` : `${bad.filter((r) => flagged(r, t)).length}/${bad.length} rejected drafts flagged`;
  }
  return row;
});
out.grid = table;
const dir = path.join(projectRoot, "documentation", "spec", "evidence", "task-010");
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, `advisory-eval-${out.startedAt.replace(/[-:]/g, "").slice(0, 15)}Z.json`), JSON.stringify(out, null, 1));
console.table(table);
