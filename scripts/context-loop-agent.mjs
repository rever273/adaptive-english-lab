// Context Loop agent batches (TASK_037, D161): deterministic preparation and checks; the sentences and the review always come from agents.
// prepare -> author-packet.json; the agent writes drafts.json; author -> candidates.json (same code checks as the local model);
// check -> final-review-packet.json + review-template.json; the independent reviewer writes review.json; finalize -> the running service.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { loadServerModule, requireBuild } from "./_common.mjs";
requireBuild({ web: false });
const [command, id, ...args] = process.argv.slice(2);
if (!["prepare", "author", "check", "finalize"].includes(command) || !/^[a-f0-9-]{36}$/i.test(id ?? "")) {
  console.error("usage: npm run content:loop -- prepare|author|check|finalize <batch UUID> [--db <file>] [--work <directory>]");
  process.exit(2);
}
const opt = (k, fallback) => (args.includes(k) ? args[args.indexOf(k) + 1] : fallback);
const { loadConfig } = await loadServerModule("config.js");
const config = loadConfig();
const work = path.resolve(opt("--work", path.join(config.dataRoot, "agent-batches", `context-loop-${id}`)));
const save = (name, value) => writeFileSync(path.join(work, name), JSON.stringify(value, null, 2) + "\n");
const read = (name) => JSON.parse(readFileSync(path.join(work, name), "utf8"));
mkdirSync(work, { recursive: true });

try {
  if (command === "finalize") {
    if (args.includes("--db")) throw new Error("finalize uses the running local service; --db is for read-only preparation only");
    const cand = read("candidates.json");
    const review = read("review.json");
    if (cand.batch_id !== id) throw new Error("candidates.json belongs to another batch");
    const base = `http://127.0.0.1:${config.port}`;
    const boot = await fetch(`${base}/api/v1/session`);
    if (!boot.ok) throw new Error(`Local service bootstrap failed (${boot.status}); start the app with npm start`);
    const cookie = boot.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Local service did not issue its session cookie");
    const { csrfToken } = await boot.json();
    const body = { author: cand.author, candidates: cand.candidates, review: { reviewer: review.reviewer, items: review.items.filter((i) => i.verdict).map((i) => ({ hash: i.hash, verdict: i.verdict, ...(i.reason ? { reason: String(i.reason).slice(0, 300) } : {}) })) } };
    const res = await fetch(`${base}/api/v1/context-loop/agent-batches/${id}/complete`, { method: "POST", headers: { "content-type": "application/json", origin: base, cookie, "x-csrf-token": csrfToken }, body: JSON.stringify(body) });
    const result = await res.json();
    if (!res.ok) throw Object.assign(new Error(result?.error?.message ?? `HTTP ${res.status}`), { details: result?.error?.details ?? result });
    save("result.json", result);
    console.log(JSON.stringify(result));
  } else {
    const { openDatabase } = await loadServerModule("db/open.js");
    const gen = await loadServerModule("domain/contextLoop/generate.js");
    const { ContextLedger, checkAndAccept } = await loadServerModule("domain/contextLoop/validate.js");
    const { CONTEXT_LOOP_SYSTEM_V1, TRANSLATION_RULE } = await loadServerModule("domain/contextLoop/prompts.js");
    const db = openDatabase(path.resolve(opt("--db", config.dbPath)), { readonly: true });
    try {
      const batch = gen.loadBatch(db, id);
      if (batch.author !== "agent") throw new Error("This batch is written by the local model, not by an agent");
      if (batch.status !== "awaiting_agent") throw new Error(`This batch is ${batch.status}; nothing to write`);
      const byTarget = new Map(batch.words.map((w) => [w.targetId, w]));
      if (command === "prepare") {
        save("author-packet.json", {
          schema_version: "context-loop-author-packet-v2",
          batch_id: id,
          sentences_per_target: batch.perWord,
          learner_level: gen.levelOf(db),
          rules: CONTEXT_LOOP_SYSTEM_V1,
          extra_rules: [
            "Write exactly sentences_per_target sentences for every target: different situations, people and sentence types.",
            "target_surface is the exact form of the word as it appears in the sentence (the word must appear exactly once).",
            "3-14 words, one plain sentence ending with . ? or !, no blanks, no options, no markup.",
            "Never use a word from avoid_words (synonyms give the meaning away) and never reuse an avoid_sentences text.",
            TRANSLATION_RULE,
          ],
          draft_format: { drafts: [{ target_id: "t1", text: "natural English sentence", translation_ru: "естественный перевод всего предложения", target_surface: "exact form used", context_label: "short context, e.g. work", difficulty: "easy|medium|challenging" }] },
          targets: batch.words.map(gen.targetInput),
        });
        if (!existsSync(path.join(work, "drafts.json"))) save("drafts.json", { drafts: [] });
        console.log(`Read content/agent-workflows/context-loop.md and ${path.join(work, "author-packet.json")}. Write ${path.join(work, "drafts.json")}, then run: npm run content:loop -- author ${id}`);
      } else if (command === "author") {
        const drafts = read("drafts.json").drafts ?? [];
        const previous = existsSync(path.join(work, "candidates.json")) ? read("candidates.json") : null;
        const ledger = new ContextLedger(db);
        const problems = [];
        const candidates = [];
        const count = new Map();
        for (const d of drafts) {
          const w = byTarget.get(String(d.target_id ?? ""));
          if (!w) { problems.push(`${d.target_id}: unknown target_id`); continue; }
          if ((count.get(w.targetId) ?? 0) >= batch.perWord) { problems.push(`${w.targetId} (${w.lemma}): more than ${batch.perWord} sentences; extra ones are ignored`); continue; }
          const r = checkAndAccept(d, gen.targetOfBatchWord(w), ledger);
          if (!r.ok) { problems.push(`${w.targetId} (${w.lemma}) "${String(d.text ?? "").slice(0, 80)}": ${r.message}`); continue; }
          if (!r.sentence.translationRu) { problems.push(`${w.targetId} (${w.lemma}) "${r.sentence.text.slice(0, 80)}": translation_ru is missing`); continue; }
          const c = { target_id: w.targetId, text: r.sentence.text, translation_ru: r.sentence.translationRu, target_surface: r.sentence.targetSurface, context_label: r.sentence.contextLabel, difficulty: r.sentence.difficulty };
          candidates.push({ ...c, hash: gen.candidateHash(c) });
          count.set(w.targetId, (count.get(w.targetId) ?? 0) + 1);
        }
        for (const w of batch.words) if ((count.get(w.targetId) ?? 0) < batch.perWord) problems.push(`${w.targetId} (${w.lemma}): ${count.get(w.targetId) ?? 0} of ${batch.perWord} sentences passed; write more`);
        save("candidates.json", { batch_id: id, author: previous?.author ?? "agent:SET-ME@1", candidates });
        console.log(`Candidates: ${candidates.length} of ${drafts.length} drafts passed the code checks.`);
        for (const p of problems) console.log(`PROBLEM ${p}`);
        if (problems.length === 0) console.log(`Set "author" in candidates.json to agent:<your identity>@<version>, then run: npm run content:loop -- check ${id}`);
      } else {
        const cand = read("candidates.json");
        if (cand.batch_id !== id) throw new Error("candidates.json belongs to another batch");
        if (!/^agent:[A-Za-z0-9._-]{1,60}@[A-Za-z0-9._-]{1,30}$/.test(cand.author ?? "") || cand.author === "agent:SET-ME@1") throw new Error('Set "author" in candidates.json to agent:<your identity>@<version> first');
        const items = cand.candidates.map((c) => {
          const w = byTarget.get(c.target_id);
          if (!w || gen.candidateHash(c) !== c.hash) throw new Error(`candidates.json was edited by hand at ${c.target_id}; run author again`);
          return { hash: c.hash, word: w.lemma, part_of_speech: w.sense.pos, meaning_ru: w.sense.translationRu, sentence: c.text, target: c.target_surface, translation_ru: c.translation_ru ?? "" };
        });
        save("final-review-packet.json", {
          schema_version: "context-loop-review-packet-v2",
          batch_id: id,
          checklist: ["target used in exactly the given meaning", "natural, grammatical contemporary English (AU/UK spelling)", "unambiguous", "the context does not define or give away the meaning", "different situations across the sentences of one word", "translation_ru is an accurate, natural Russian translation of the whole sentence, with the target in the given meaning (a wrong translation is a flag with the corrected translation)"],
          verdicts: "accept = good as it is; flag = usable idea but a real problem (say it); reject = unusable",
          items,
        });
        if (!existsSync(path.join(work, "review.json"))) save("review-template.json", { reviewer: "agent:<reviewer identity>@<version>", items: items.map((i) => ({ hash: i.hash, verdict: "", reason: "" })) });
        console.log(`Checked ${items.length} candidates. The independent reviewer (not the author) reads final-review-packet.json and writes review.json in the format of review-template.json. No database changes.`);
      }
    } finally {
      db.close();
    }
  }
} catch (e) {
  console.error(`REFUSED: ${e.message}`);
  if (e.details) console.error(JSON.stringify(e.details));
  process.exitCode = 1;
}
