// Deterministic preparation and audited application; linguistic decisions always come from the reviewing agent.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadServerModule, requireBuild } from "./_common.mjs";
requireBuild({ web: false });
const [command, id, ...args] = process.argv.slice(2);
if (!["prepare", "check", "finalize"].includes(command) || !/^[a-f0-9-]{36}$/i.test(id ?? "")) {
  console.error("usage: npm run content:agent -- prepare|check|finalize <batch UUID> [--db <file>] [--work <directory>]");
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
    const { skillCards } = await loadServerModule("domain/content/batches/draftFormats.js");
    const { exerciseIdFor } = await loadServerModule("domain/content/batches/generationRunner.js");
    const db = openDatabase(path.resolve(opt("--db", config.dbPath)), { readonly: true });
    try {
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
          console.log(`Read content/agent-workflows/${exported.batch.category}.md and ${path.join(work, "packet.json")}. Edit plan.json; then run check.`);
        } else {
          const plan = read("plan.json");
          if (plan.batch_id !== id) throw new Error("Plan belongs to another batch");
          const packet = prepareCompletion(db, plan);
          save("final-review-packet.json", packet);
          save("review-template.json", packet.reviewManifestTemplate);
          console.log(`Checked ${packet.items.length} final candidates. Independent reviewer reads final-review-packet.json and writes review.json. No database changes.`);
        }
      }).deferred();
    } finally { db.close(); }
  }
} catch (e) {
  console.error(`REFUSED: ${e.message}`);
  if (e.details) console.error(JSON.stringify(e.details));
  process.exitCode = 1;
}

