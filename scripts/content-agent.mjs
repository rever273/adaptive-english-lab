// Deterministic preparation and audited application; linguistic decisions always come from the reviewing agent.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadServerModule, requireBuild } from "./_common.mjs";
requireBuild({ web: false });
const [command, id, ...args] = process.argv.slice(2);
if (!["prepare", "author", "check", "finalize"].includes(command) || !/^[a-f0-9-]{36}$/i.test(id ?? "")) {
  console.error("usage: npm run content:agent -- prepare|author|check|finalize <batch UUID> [--db <file>] [--work <directory>]");
  process.exit(2);
}
const opt = (k, fallback) => args.includes(k) ? args[args.indexOf(k) + 1] : fallback;
const { loadConfig } = await loadServerModule("config.js");
const config = loadConfig();
const work = path.resolve(opt("--work", path.join(config.dataRoot, "agent-batches", id)));
const save = (name, value) => writeFileSync(path.join(work, name), JSON.stringify(value, null, 2) + "\n");
const read = name => JSON.parse(readFileSync(path.join(work, name), "utf8"));
mkdirSync(work, { recursive: true });
try {
  if (command === "finalize") {
    if (args.includes("--db")) throw new Error("finalize uses the running local service; --db is read-only preparation only");
    const body = { plan: read("plan.json"), review: read("review.json") };
    if (body.plan.batch_id !== id) throw new Error("Plan belongs to another batch");
    const base = `http://127.0.0.1:${config.port}`;
    const boot = await fetch(`${base}/api/v1/session`);
    if (!boot.ok) throw new Error(`Local service bootstrap failed (${boot.status})`);
    const cookie = boot.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Local service did not issue its session cookie");
    const { csrfToken } = await boot.json();
    const res = await fetch(`${base}/api/v1/content/batches/${id}/complete`, { method: "POST", headers: { "content-type": "application/json", origin: base, cookie, "x-csrf-token": csrfToken }, body: JSON.stringify(body) });
    const result = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(result));
    save("result.json", result);
    console.log(JSON.stringify(result));
  } else {
    const { openDatabase } = await loadServerModule("db/open.js");
    const { completionPlanTemplate, prepareCompletion } = await loadServerModule("domain/content/batches/completion.js");
    const { exportBatch } = await loadServerModule("domain/content/batches/export.js");
    const { skillCards, assembleExercise, buildGenerationUserV4, draftFormat } = await loadServerModule("domain/content/batches/draftFormats.js");
    const { exerciseIdFor, GenerationJobRunner } = await loadServerModule("domain/content/batches/generationRunner.js");
    const { LexiconHints } = await loadServerModule("domain/vocabulary/lexiconHint.js");
    const { assembleVocabulary } = await loadServerModule("domain/content/batches/vocabularyDrafts.js");
    const { checkDuplicates, taxonomyForNewRevisions } = await loadServerModule("domain/content/repository.js");
    const { validateExercise } = await loadServerModule("domain/content/validator.js");
    const runner = db => new GenerationJobRunner({ db, chat: null, installedDigest: async () => null, runtimeVersion: async () => "", deps: { now: () => new Date(), newId: () => "" }, lexicon: new LexiconHints(config.lexiconCsv) });
    const db = openDatabase(path.resolve(opt("--db", config.dbPath)), { readonly: true });
    try {
      let authoring = null;
      db.transaction(() => {
        if (command === "prepare") {
          const exported = exportBatch(db, id).json;
          if (!exported.batch.generationDone) throw new Error("Generation is not finished; inspect AI Tasks before preparing review");
          const targets = new Set(exported.items.map(i => i.plan.target_skill));
          const linguistic = c => c && Object.fromEntries(["type", "difficulty", "context_level", "prompt_en", "hints_ru", "explanation_ru", "payload", "vocabulary", "provenance", "sources"].filter(k => c[k] !== undefined).map(k => [k, k === "provenance" ? { origin: c[k].origin, model: c[k].model_tag, prompt: c[k].prompt_version } : c[k]]));
          const packet = { schema_version: "agent-batch-packet-v1", batch: exported.batch, items: exported.items.map(({ ordinal, plan, content, error }) => ({ ordinal, exerciseId: content?.id ?? exerciseIdFor(id, ordinal), plan, content: linguistic(content), error })), skills: Object.fromEntries([...targets].map(s => [s, skillCards()[s] ?? null])) };
          // Never overwrite an in-progress agent's decisions.
          save("packet.json", packet);
          const file = path.join(work, "plan.json");
          try { readFileSync(file); } catch { save("plan.json", completionPlanTemplate(db, id)); }
          const authored = exported.items.length > 0 && exported.items.every(i => i.error?.stage === "agent_authoring");
          if (authored) authoring = exported.items;
          console.log(`Read content/agent-workflows/${exported.batch.category}.md and ${path.join(work, authored ? "author-packet.json" : "packet.json")}. ${authored ? "Write drafts.json, run author, then check." : "Edit plan.json; then run check."}`);
        } else if (command === "author") {
          const exported = exportBatch(db, id).json;
          const drafts = read("drafts.json").drafts ?? [];
          const plan = (() => { try { return read("plan.json"); } catch { return completionPlanTemplate(db, id); } })();
          const gen = runner(db);
          const skills = taxonomyForNewRevisions(db).skills;
          const problems = [];
          let ok = 0;
          const texts = new Map();
          for (const raw of drafts) {
            const item = exported.items.find(i => i.ordinal === raw.ordinal);
            const entry = plan.items.find(i => i.ordinal === raw.ordinal);
            if (!item || !entry) { problems.push(`${raw.ordinal}: unknown ordinal`); continue; }
            const label = item.plan.vocabulary ? item.plan.vocabulary.lemma : item.plan.target_skill;
            const built = item.plan.vocabulary
              ? assembleVocabulary(raw, item.plan, exerciseIdFor(id, raw.ordinal), { tag: "agent", digest: "agent" }, skills, "vocabulary-generation-v8", gen.synonymsOf(item.plan.vocabulary.lemma))
              : assembleExercise(Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "ordinal")), item.plan, { exerciseId: exerciseIdFor(id, raw.ordinal), model: { tag: "agent", digest: "agent" }, promptVersion: "generation-v10", taxonomySkillIds: skills });
            let message = built.ok ? null : built.issues.map(x => x.message).join("; ");
            if (built.ok) {
              const v = validateExercise(built.exercise, { taxonomySkillIds: skills });
              if (v.ok) {
                const d = checkDuplicates(db, { exerciseId: built.exercise.id, templateCluster: built.exercise.template_cluster, targetSkill: built.exercise.target_skill, units: v.units });
                if (d.errors.length || d.warnings.some(w => w.code === "NEAR_DUPLICATE")) message = "this sentence is already in the bank or almost the same as one; write a different one";
              }
            }
            if (message) { problems.push(`${raw.ordinal} (${label}): ${message}`); entry.action = "reject"; delete entry.patch; entry.reason = "the draft has problems; rewrite it in drafts.json and run author again"; continue; }
            const e = built.exercise;
            entry.action = "replace";
            entry.reason = "written by the agent";
            entry.patch = { prompt_en: e.prompt_en, hints_ru: e.hints_ru, explanation_ru: e.explanation_ru, payload: e.payload, difficulty: e.difficulty, context_level: e.context_level, template_cluster: e.template_cluster, ...(e.vocabulary ? { vocabulary: e.vocabulary } : {}), ...(e.sources?.length ? { sources: e.sources } : {}) };
            texts.set(raw.ordinal, { group: item.plan.vocabulary ? `w:${item.plan.vocabulary.lemma.toLowerCase()}` : `s:${item.plan.target_skill}:${item.plan.type}`, text: item.plan.type === "detect_error" ? String(e.payload.sentence ?? e.prompt_en) : /_{2,}/.test(e.prompt_en) ? e.prompt_en : String(e.payload.accepted_answers?.[0] ?? e.prompt_en), label });
            ok++;
          }
          // variety inside the batch: two drafts for the same word (or the same grammar skill and format) must not share a frame
          const words = t => t.toLowerCase().replace(/[^a-z0-9' _]+/g, " ").split(/\s+/).filter(Boolean);
          const frame = t => { const w = words(t); const g = w.indexOf("___"); return g >= 0 ? `${w.slice(Math.max(0, g - 2), g).join(" ")} _ ${w.slice(g + 1, g + 3).join(" ")}` : w.slice(0, 4).join(" "); };
          const trigrams = t => { const w = words(t).filter(x => x !== "___"); return new Set(w.slice(2).map((_, i) => w.slice(i, i + 3).join(" "))); };
          const jaccard = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n / Math.max(1, a.size + b.size - n); };
          const kept = [];
          for (const [ordinal, t] of [...texts].sort((a, b) => a[0] - b[0])) {
            const clash = kept.find(k => k.group === t.group && (frame(k.text) === frame(t.text) || jaccard(trigrams(k.text), trigrams(t.text)) >= 0.4));
            const entry = plan.items.find(i => i.ordinal === ordinal);
            if (clash) {
              problems.push(`${ordinal} (${t.label}): same frame or scene as ${clash.ordinal}; change the situation, the people and the sentence type`);
              entry.action = "reject"; delete entry.patch; entry.reason = "the draft repeats the frame of another draft for the same word or skill; rewrite it and run author again"; ok--;
            } else kept.push({ ordinal, ...t });
          }
          for (const entry of plan.items) if (entry.action === "reject" && !entry.reason) entry.reason = "no draft was written for this item";
          save("plan.json", plan);
          console.log(`Drafts accepted into plan.json: ${ok} of ${drafts.length}.`);
          for (const m of problems) console.log(`PROBLEM ${m}`);
          if (problems.length === 0) console.log("Set plan.author, then run check.");
        } else {
          const plan = read("plan.json");
          if (plan.batch_id !== id) throw new Error("Plan belongs to another batch");
          const packet = prepareCompletion(db, plan);
          save("final-review-packet.json", packet);
          save("review-template.json", packet.reviewManifestTemplate);
          console.log(`Checked ${packet.items.length} final candidates. Independent reviewer reads final-review-packet.json and writes review.json. No database changes.`);
        }
      }).deferred();
      if (authoring) {
      const gen = runner(db);
            const items = [];
      const formats = {};
      for (const i of authoring) {
        if (i.plan.vocabulary) items.push({ ordinal: i.ordinal, family: i.plan.vocabulary.family, word: i.plan.vocabulary.lemma, translation_ru: i.plan.vocabulary.translationRu, level: i.plan.level ?? "B2", ...(await gen.authoringContext(i.plan)) });
        else {
          const req = JSON.parse(buildGenerationUserV4(id, [i.plan], "generation-v10"));
          const key = i.plan.variant ? `${i.plan.type}:${i.plan.variant}` : i.plan.type;
          formats[key] ??= { rules: req.format_rules, schema_of_one_draft: draftFormat(i.plan.type, 1, "generation-v10", i.plan.variant).properties.drafts.items };
          items.push({ ordinal: i.ordinal, format: key, ...req.items[0] });
        }
      }
      save("author-packet.json", {
              schema_version: "agent-authoring-packet-v1",
              instructions: "Write ONE draft per item into drafts.json as {\"drafts\":[{\"ordinal\":N, ...}]} in the format given for its family (vocabulary) or format (grammar; see formats), then run: npm run content:agent -- author <batch>. topic_ideas are optional suggestions; never force a word into a topic. target_level is the CEFR level of the sentence. VARIETY IS ENFORCED: before writing, plan the items of each word (or grammar skill) together and give every one its own scene, people and sentence type (statement, question, request, condition, passive, comparison, time clause, negative...); never reuse an opening, never use the same two words before and after the gap, never repeat 'had to ___ the problem by -ing' style frames; the author command rejects repeats and so does the reviewer. Vocabulary wrong options: choose from distractor_candidates when they are clearly wrong in your sentence (a studied word may appear at most once), otherwise invent your own; never use a synonym or any word that also fits. Grammar: follow skill_card (rule, good and bad examples) exactly, test only the target skill, keep one defensible answer, and never copy the card's examples.",
              ...(items.some(x => x.family) ? {
              draft_format: {
                recognition_and_collocation: { ordinal: "number", sentence: "one ___ gap, target word nowhere else", hint_ru: "short Russian hint, no answer", explanation_ru: "1-2 Russian sentences", part_of_speech: "noun|verb|adjective|adverb|phrasal verb|...", sense_id: "\"1\"", surface_form: "exact form in the gap", sentence_ru: "natural Russian translation", word_ru: "Russian meaning in this sentence", options: "[{text, rationale_ru}] 3 items, one is the target form", correct_index: "index of the target form", pattern: "collocation only: the natural phrase" },
                guided_recall: { ordinal: "number", sentence: "one ___ gap", hint_ru: "...", explanation_ru: "...", part_of_speech: "...", sense_id: "\"1\"", surface_form: "exact form", sentence_ru: "...", word_ru: "...", cue_ru: "(глаг., на X...) русское значение, X = first Latin letter; the program adds the answer length", accepted_answers: "[surface_form, other spellings of the same word only]" }
              }
              } : {}),
              ...(Object.keys(formats).length ? { formats } : {}),
              items
            });
      }
    } finally { db.close(); }
  }
} catch (e) {
  console.error(`REFUSED: ${e.message}`);
  if (e.details) console.error(JSON.stringify(e.details));
  process.exitCode = 1;
}

