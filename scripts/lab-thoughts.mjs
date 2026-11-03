// npm run lab:thoughts -- export | apply <manifest.json>   [--db <sqlite file>] [--out <dir>]
// TASK_026: the local model reads the learner's own Russian thoughts but does not choose grammar skills. `export` (read-only) lists the thoughts
// waiting for that choice; `apply` appends the agent's thought-skill-review-v1 decisions (all or nothing, safe to run twice, the model's reading stays in the history).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadServerModule, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const [cmd, file] = args;
if (!(cmd === "export" || (cmd === "apply" && file && !file.startsWith("--")))) {
  console.error("usage: npm run lab:thoughts -- export | apply <manifest.json>  [--db <sqlite file>] [--out <dir>]");
  process.exit(2);
}
const { loadConfig } = await loadServerModule("config.js");
const { openDatabase } = await loadServerModule("db/open.js");
const { thoughtsForSkillReview, skillChoices, applyThoughtSkills } = await loadServerModule("domain/thoughts/skillReview.js");
const config = loadConfig();
const dbFile = path.resolve(opt("--db") ?? config.dbPath);
if (!existsSync(dbFile)) {
  console.error(`database not found: ${dbFile}`);
  process.exit(2);
}
const db = openDatabase(dbFile, cmd === "export" ? { readonly: true } : undefined);
try {
  if (cmd === "export") {
    const outDir = path.resolve(opt("--out") ?? path.join(config.dataRoot, "exports"));
    const items = db.transaction(() => thoughtsForSkillReview(db)).deferred();
    const skills = db.transaction(() => skillChoices(db)).deferred();
    const template = { schema_version: "thought-skill-review-v1", reviewer: "agent:<name>@<version>", review_version: "<review pass id>", items: items.map((t) => ({ analysis_id: t.analysis_id, constructions: t.constructions.map((c) => ({ index: c.index, skill_id: "<skill id from skills, or null if none genuinely fits>", rationale: "<one line>" })) })) };
    const md = [
      "# Thoughts waiting for a grammar-skill choice",
      "",
      "The local model proposed an English reading and reusable patterns for each thought; it did NOT choose skills (it chose wrongly about half of the time). For EVERY pattern pick the one skill from `skills` whose RULE the pattern genuinely exercises, judging by the rule text and the pattern, not by the words of the skill id. If nothing fits, use null: do not take the nearest-sounding skill. A pattern that only contains a word (would, to, before) does not exercise a skill about another use of that word. Also use null for a pattern that is wrong for the sentence.",
      "Then write a thought-skill-review-v1 manifest (template in the JSON file: reviewer `agent:<name>@<version>`, review_version, one entry per pattern with index, skill_id, rationale) and apply it with: npm run lab:thoughts -- apply <manifest.json>. Do not edit the database any other way. Keep the thoughts private: do not copy them into Git or public files.",
      "",
      ...items.flatMap((t) => [`## ${t.analysis_id}`, `thought: ${t.thought_ru}`, `english (model draft): ${t.english}`, ...t.constructions.map((c) => `- [${c.index}] ${c.pattern} (${c.why_ru})`), ""]),
      "## skills",
      ...skills.map((s) => `- ${s.skill_id}: ${s.rule}`),
    ].join("\n");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "thoughts.json"), JSON.stringify({ schema_version: "thought-export-v1", exportedAt: new Date().toISOString(), thoughts: items, skills, reviewManifestTemplate: template }, null, 1));
    writeFileSync(path.join(outDir, "thoughts.md"), md);
    console.log(`exported ${items.length} thought(s)\n  ${path.join(outDir, "thoughts.json")}\n  ${path.join(outDir, "thoughts.md")}`);
  } else {
    console.log(JSON.stringify(applyThoughtSkills(db, { now: () => new Date(), newId: randomUUID }, JSON.parse(readFileSync(path.resolve(file), "utf8"))), null, 2));
  }
} catch (e) {
  console.error(`not applied: ${e.message}`);
  if (e.details) console.error(JSON.stringify(e.details, null, 2));
  process.exitCode = 1;
} finally {
  db.close();
}
