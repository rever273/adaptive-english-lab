// npm run cloze:prepare -- --source zanichelli --input data/train_exercise_dataset.json [--out var/grammar-cloze/zanichelli] [--config scripts/grammar-cloze/config.json]
// Cleans and classifies a column-oriented gap-fill dataset (TASK_032). The input is only READ (its sha256 is checked before and after) and its rows are
// never printed: the console shows counts and a few clipped samples. Output (rewritten on every run, identical for identical input and config):
// cleaned.json, excluded.jsonl (rejected), flagged.jsonl, report.json, report.md, samples.json. Needs `npm run build` (compiled server modules).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadServerModule, projectRoot, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const source = opt("--source", "zanichelli");
const input = path.resolve(opt("--input", "data/train_exercise_dataset.json"));
const out = path.resolve(opt("--out", path.join("var", "grammar-cloze", source)));
const configPath = path.resolve(opt("--config", path.join("scripts", "grammar-cloze", "config.json")));
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

const { readColumnar } = await loadServerModule("domain/grammarCloze/source.js");
const { cleanAll } = await loadServerModule("domain/grammarCloze/clean.js");
const { classify, CLASSIFIER_VERSION } = await loadServerModule("domain/grammarCloze/classify.js");
const { canonicalCards } = await loadServerModule("domain/skills/cards.js");

const inputBuf = readFileSync(input);
const inputSha = sha(inputBuf);
const configText = readFileSync(configPath, "utf8");
const cfg = JSON.parse(configText);
const { rows, rejected: early, indexSetsMatch } = readColumnar(JSON.parse(inputBuf.toString("utf8")));
const { items, rejected, report: cleanReport } = cleanAll(rows, cfg, early);

const cards = canonicalCards().skills;
const classified = items.map((it) => {
  const c = classify(it);
  if (c.skillId && !cards[c.skillId]) throw new Error(`classifier returned an unknown skill: ${c.skillId}`);
  const flagReasons = [...it.flagReasons, ...c.riskFlags];
  return { ...it, skillId: c.skillId, skillConfidence: c.confidence, classifierRule: c.rule, flagReasons, status: flagReasons.length ? "flagged" : "validated" };
});
const active = classified.filter((i) => i.status === "validated");

// ---- statistics
const count = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] ?? 0) + 1; return m; }, {});
const sortObj = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
const topics = sortObj(count(active, (i) => i.sourceTopic));
const optionCounts = sortObj(count(active, (i) => String(i.distractors.length + 1)));
const bySkill = sortObj(count(active, (i) => i.skillId ?? "(General Grammar)"));
const exactByTopic = {};
for (const i of classified) { const t = (exactByTopic[i.sourceTopic] ??= { exact: 0, general: 0 }); t[i.skillConfidence === "exact" ? "exact" : "general"]++; }
const ruleHits = sortObj(count(classified, (i) => `${i.sourceTopic}:${i.classifierRule}`));
const flagByTopic = {};
for (const i of classified) for (const f of i.flagReasons) { const k = `${i.sourceTopic}:${f}`; flagByTopic[k] = (flagByTopic[k] ?? 0) + 1; }
const topicTotal = count(classified, (i) => i.sourceTopic);
const flagShares = Object.fromEntries(Object.entries(flagByTopic).map(([k, n]) => [k, { count: n, share: +(n / topicTotal[k.split(":")[0]]).toFixed(3) }]));
const rejectedBy = sortObj(cleanReport.rejected);
const reportObj = {
  source, inputSha256: inputSha, configSha256: sha(configText), cleanVersion: cfg.version, classifierVersion: CLASSIFIER_VERSION, indexSetsMatch,
  total: cleanReport.total, afterCleaning: items.length, validated: active.length, flagged: classified.length - active.length, rejected: rejected.length,
  rejectedByReason: rejectedBy, fixes: sortObj(cleanReport.fixes), flaggedByReason: sortObj(count(classified.flatMap((i) => i.flagReasons), (x) => x)), flagShares,
  noFinalPunctuation: cleanReport.noFinalPunctuation, thresholds: { minWords: cfg.minWords, maxWords: cfg.maxWords, maxOptionWords: cfg.maxOptionWords, maxOptionChars: cfg.maxOptionChars }, sweep: cleanReport.sweep,
  validatedByTopic: topics, validatedByOptionCount: optionCounts, validatedBySkill: bySkill, exactByTopic, classifierRuleHits: ruleHits,
};

// ---- samples: 5 per skill, deterministic (stable hash of the source index), clipped
const clip = (s) => (s.length > 160 ? s.slice(0, 157) + "..." : s);
const samples = {};
for (const skill of Object.keys(bySkill)) {
  samples[skill] = active.filter((i) => (i.skillId ?? "(General Grammar)") === skill)
    .sort((a, b) => sha(`${a.sourceIndex}`).localeCompare(sha(`${b.sourceIndex}`))).slice(0, 5)
    .map((i) => `${clip(i.gappedText)}  =>  ${i.solution}  [${i.distractors.join(", ")}]  (${i.classifierRule})`);
}

mkdirSync(out, { recursive: true });
if (sha(readFileSync(input)) !== inputSha) throw new Error("the input file changed while it was processed");
const keep = (i) => ({ sourceIndex: i.sourceIndex, gappedText: i.gappedText, solution: i.solution, distractors: i.distractors, filledText: i.filledText, sourceTopic: i.sourceTopic, skillId: i.skillId, skillConfidence: i.skillConfidence, classifierRule: i.classifierRule, status: i.status, flagReasons: i.flagReasons, fixes: i.fixes, contentHash: i.contentHash });
writeFileSync(path.join(out, "cleaned.json"), JSON.stringify({ source, sourceSha256: inputSha, cleanVersion: cfg.version, classifierVersion: CLASSIFIER_VERSION, configSha256: reportObj.configSha256, items: classified.map(keep) }), "utf8");
writeFileSync(path.join(out, "excluded.jsonl"), rejected.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
writeFileSync(path.join(out, "flagged.jsonl"), classified.filter((i) => i.status === "flagged").map((i) => JSON.stringify({ sourceIndex: i.sourceIndex, sourceTopic: i.sourceTopic, flagReasons: i.flagReasons })).join("\n") + "\n", "utf8");
writeFileSync(path.join(out, "report.json"), JSON.stringify(reportObj, null, 2), "utf8");
const table = (o) => Object.entries(o).map(([k, v]) => `| ${k} | ${typeof v === "object" ? JSON.stringify(v) : v} |`).join("\n");
const md = [
  `# Grammar Cloze preparation: ${source}`,
  "",
  `Input sha256 ${inputSha.slice(0, 12)}..., clean ${cfg.version}, classifier ${CLASSIFIER_VERSION}. Passing the checks does not mean the answer key is verified.`,
  "",
  `- Records: **${reportObj.total}**; usable after cleaning: **${items.length}**; active (validated): **${active.length}**; flagged (kept out of the active set): **${reportObj.flagged}**; rejected: **${rejected.length}**`,
  `- Index sets of the 5 fields match: ${indexSetsMatch}`,
  "",
  "## Rejected, by reason", "| reason | n |", "|---|---|", table(rejectedBy),
  "", "## Automatically fixed (counts of fixes)", "| fix | n |", "|---|---|", table(reportObj.fixes),
  "", "## Flagged (kept out of the active set), by reason", "| reason | n |", "|---|---|", table(reportObj.flaggedByReason),
  "", "## Sentence-length thresholds (words): rows cut if the limit were...",
  `min: ${JSON.stringify(cleanReport.sweep.minWords)} | max: ${JSON.stringify(cleanReport.sweep.maxWords)} | used: min ${cfg.minWords}, max ${cfg.maxWords}`,
  "", "## Active items by topic", "| topic | n |", "|---|---|", table(topics),
  "", "## Active items by number of options", JSON.stringify(optionCounts),
  "", "## Exact skill label / General Grammar, by topic (all usable items)", "| topic | exact / general |", "|---|---|",
  Object.entries(exactByTopic).map(([k, v]) => `| ${k} | ${v.exact} / ${v.general} |`).join("\n"),
  "", "## Active items by skill", "| skill | n |", "|---|---|", table(bySkill), "",
].join("\n");
writeFileSync(path.join(out, "report.md"), md, "utf8");
writeFileSync(path.join(out, "samples.json"), JSON.stringify(samples, null, 2), "utf8");
if (!args.includes("--quiet")) console.log(md);
console.log(`Files written to ${path.relative(projectRoot, out)} (cleaned.json sha256 ${sha(readFileSync(path.join(out, "cleaned.json"))).slice(0, 16)})`);
