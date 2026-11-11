// npm run skills:labels [-- --check]
// apps/web/src/skillLabels.json is DERIVED from content/taxonomy/skill-cards.json (TASK_032, D142): only taxonomy-v1 skills, the labels the
// grammar Practice already shows. --check only compares and exits 1 on a difference.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "./_common.mjs";

const cards = JSON.parse(readFileSync(path.join(projectRoot, "content", "taxonomy", "skill-cards.json"), "utf8")).skills;
const labels = {};
for (const [id, s] of Object.entries(cards)) if (s.since === "taxonomy-v1") labels[id] = { en: s.displayName, ru: s.displayNameRu };
const text = JSON.stringify(labels, null, 2); // no final newline, exactly like the committed file
const file = path.join(projectRoot, "apps", "web", "src", "skillLabels.json");
const current = readFileSync(file, "utf8");
if (process.argv.includes("--check")) {
  if (current.replace(/\r\n/g, "\n") !== text) { console.error("skillLabels.json is out of date: run npm run skills:labels"); process.exit(1); }
  console.log("skillLabels.json is in sync");
} else {
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  writeFileSync(file, text.replace(/\n/g, eol), "utf8");
  console.log(`wrote ${Object.keys(labels).length} labels`);
}
