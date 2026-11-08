// npm run lessons:trial -- <word> [<word> ...]   (REAL gemma4:12b; isolated profile var/trial-word-lessons; the learner's database is only READ)
// Writes one Single Word lesson per word the way the app does and prints it, so the prompts can be judged before the learner sees a lesson.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadServerModule, projectRoot, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const words = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (words.length === 0) {
  console.error("Usage: npm run lessons:trial -- <word> [<word> ...]");
  process.exit(2);
}
const root = path.join(projectRoot, "var", "trial-word-lessons");
rmSync(root, { recursive: true, force: true });
mkdirSync(path.join(root, "db"), { recursive: true });

const { openDatabase } = await loadServerModule("db/open.js");
const { runMigrations } = await loadServerModule("db/migrate.js");
const { OllamaClient } = await loadServerModule("adapters/gpu/ollamaClient.js");
const { OllamaChatClient } = await loadServerModule("adapters/ollama/chat.js");
const { GenerationJobRunner } = await loadServerModule("domain/content/batches/generationRunner.js");
const jobs = await loadServerModule("queue/jobs.js");
const sel = await loadServerModule("domain/wordLessons/selection.js");
const gen = await loadServerModule("domain/wordLessons/generate.js");
const planMod = await loadServerModule("domain/wordLessons/plan.js");
const policy = await loadServerModule("domain/sessions/policy.js");

const local = JSON.parse(readFileSync(path.join(projectRoot, "englishlab.local.json"), "utf8"));
const real = openDatabase(path.join(local.dbDir, "english-lab.sqlite"), { readonly: true });
const settings = policy.loadSettings(real).values;
const pool = planMod.loadSkillPool(real, new Date().toISOString());
const { eligible } = sel.eligibleWords(real);

const client = new OllamaClient();
const version = await client.json("/api/version", { method: "GET", timeoutMs: 5000 });
const tags = await client.json("/api/tags", { method: "GET", timeoutMs: 5000 });
const db = openDatabase(path.join(root, "db", "trial.sqlite"));
await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "word-lesson-trial" });
const deps = { now: () => new Date(), newId: randomUUID };
const runner = new GenerationJobRunner({ db, chat: new OllamaChatClient(client, 300_000), installedDigest: async (tag) => tags.models.find((m) => m.name === tag)?.digest ?? null, runtimeVersion: async () => version.version, deps });
const prep = await runner.prepare();
if (!prep.ok) {
  console.error("runner not ready:", prep.reason);
  process.exit(2);
}

let index = 0;
for (const lemma of words) {
  const w = eligible.find((x) => x.lemma === lemma);
  if (!w) {
    console.log(`\n"${lemma}" is not a saved word with a translation.`);
    continue;
  }
  const id = randomUUID();
  const plan = planMod.buildPlan(settings, pool, index++, parseInt(id.slice(0, 7), 16));
  db.prepare("INSERT INTO vocabulary_entries(id, lemma, pos, language, surface_forms_json, created_at) VALUES (?,?,?,?,?,?)").run(w.entryId, w.lemma, w.pos, "en", JSON.stringify(w.surfaceForms), new Date().toISOString());
  db.prepare("INSERT INTO word_lessons(id, entry_id, lemma, sense_json, plan_json, status, generation_attempt, settings_revision, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, w.entryId, w.lemma, JSON.stringify(gen.senseOf(real, w)), JSON.stringify(plan), "generating", 1, 1, new Date().toISOString());
  const { job } = jobs.enqueue(db, deps, { kind: "generation", priority: 3, payload: { wordLessonId: id, attempt: 1 }, idempotencyKey: `trial:${id}` });
  console.log(`\n=== ${lemma}  (skills: ${plan.skills.map((s) => s.label).join(" | ")})`);
  const started = Date.now();
  let current = job;
  for (let tries = 1; tries <= 3 && current; tries++) {
    const checkpoints = [];
    const toRun = current;
    current = null;
    try {
      const out = await runner.run({ job: toRun, token: 1, signal: new AbortController().signal, checkpoint: (c) => checkpoints.push(c) });
      db.transaction(() => out.alsoCommit?.(db))();
      const row = db.prepare("SELECT status, content_json FROM word_lessons WHERE id = ?").get(id);
      console.log(`${row.status} (try ${tries}) after ${Math.round((Date.now() - started) / 1000)} s, ${out.metrics?.calls} model calls, ${out.metrics?.reviews} review(s)`);
      if (row.content_json) {
        const c = JSON.parse(row.content_json);
        const lines = [];
        c.stage1.examples.forEach((e, i) => lines.push(`S1.${i + 1} ${e.en}
     ${e.ru}`));
        lines.push(`S2   ${c.stage2.gapped_en}   -> ${c.stage2.accepted_forms.join(" / ")}
     ${c.stage2.ru}`);
        c.stage3.items.forEach((t) => lines.push(`S3   [${t.construction_en}${t.skill_id ? ` / ${t.skill_id}` : " / (no skill)"}] ${t.instruction_en}
     in : ${t.source_en}
     out: ${t.expected_en}
     hint: ${t.hint_partial_en} ...  ru: ${t.translation_ru}`));
        lines.push(`S4   [${c.stage4.construction_en}] pattern: ${c.stage4.pattern}   e.g. ${c.stage4.pattern_example_en}
     ru : ${c.stage4.cue_ru}
     out: ${c.stage4.expected_en}   (alt: ${c.stage4.accepted_en.slice(1).join(" | ") || "-"})`);
        lines.push(`S5   ${c.stage5.situation_en}
     words: ${c.stage5.suggested_words.join(", ")}
     sample: ${c.stage5.sample_en}
     start: ${c.stage5.hint_start_en}`);
        console.log(lines.join(String.fromCharCode(10)));
        writeFileSync(path.join(root, `${lemma}.json`), JSON.stringify(c, null, 2));
      }
    } catch (e) {
      console.log(`rejected (try ${tries}) after ${Math.round((Date.now() - started) / 1000)} s: ${e.code ?? ""} ${e.message}`);
      const last = checkpoints.at(-1);
      if (last?.notes) console.log("  reviewer remarks:", JSON.stringify(last.notes));
      // the app writes a rejected lesson again by itself: do the same with the job it queued
      const next = db.prepare("SELECT id FROM jobs WHERE state = 'queued' AND json_extract(payload_json, '$.wordLessonId') = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(id);
      current = next ? jobs.getJob(db, next.id) : null;
    }
  }
}
real.close();
db.close();
