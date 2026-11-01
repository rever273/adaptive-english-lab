// npm run lab:export -- batch <UUID> | session <UUID> | exercise <UUID> | coverage | vocabulary   [--db <sqlite file>] [--out <dir>]
// Read-only export for an external reviewer (spec/06): one read transaction, no writes, Markdown + JSON into <data root>/exports.
// The database is opened READ-ONLY. It is safe to run while the app is running (WAL).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadServerModule, projectRoot, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const [what, id] = positional;
const { loadConfig } = await loadServerModule("config.js");
const config = loadConfig();
const dbPath = path.resolve(opt("--db", config.dbPath));
const outDir = path.resolve(opt("--out", path.join(config.dataRoot, "exports")));

if (!["batch", "session", "exercise", "coverage", "findings", "vocabulary", "verdicts", "lesson-priorities"].includes(what)) {
  console.error("usage: npm run lab:export -- batch <UUID> | session <UUID> | exercise <UUID> (revision id) | coverage | lesson-priorities | vocabulary | verdicts [--include-ai-correct] | findings [--status tentative] [--limit 100]  [--db <file>] [--out <dir>]");
  process.exit(2);
}
if (["batch", "session", "exercise"].includes(what) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id ?? "")) {
  console.error(`${what} needs a UUID`);
  process.exit(2);
}
const { openDatabase } = await loadServerModule("db/open.js");
const { exportBatch, exportCoverage } = await loadServerModule("domain/content/batches/export.js");
const { findingsForReview } = await loadServerModule("domain/reports/findingReview.js");
const { exportSession, exportExercise } = await loadServerModule("domain/tutor/agentExport.js");
const { attemptsForVerdictReview } = await loadServerModule("domain/reports/attemptVerdictReview.js");
const { exportVocabulary } = await loadServerModule("domain/vocabulary/practice.js");
const { exportLessonPriorities } = await loadServerModule("domain/reports/lessonPriorities.js");
const db = openDatabase(dbPath, { readonly: true });
try {
  let out;
  if (what === "findings") {
    const items = db.transaction(() => findingsForReview(db, { status: opt("--status", "tentative"), limit: Number(opt("--limit", "100")) })).deferred();
    const template = { schema_version: "finding-review-v1", reviewer: "agent:<name>@<version> | human:<name>", review_version: "<review pass id>", items: items.map((f) => ({ finding_id: f.finding_id, source_hash: f.source_hash, expected_sequence: f.expected_sequence, verdict: "confirmed | rejected | disputed | uncertain", reason: "" })) };
    out = { json: { schema_version: "finding-export-v1", exportedAt: new Date().toISOString(), findings: items, reviewManifestTemplate: template }, markdown: ["# AI findings to review", "", "Judge EVERY finding against the learner answer. Return a finding-review-v1 manifest (echo finding_id, source_hash and expected_sequence unchanged). Do not modify the database.", "", ...items.flatMap((f) => [`## ${f.finding_id}`, `skill ${f.skill_id} / ${f.finding_type} / confidence ${f.confidence} / model ${f.model}`, `task: ${f.prompt}`, `answer: ${JSON.stringify(f.answer)}`, `span ${f.span.start}-${f.span.end} (code points); suggested: ${f.correction}`, `explanation: ${f.explanation_ru}`, ""])].join(String.fromCharCode(10)) };
  } else if (what === "verdicts") {
    const limit = Number(opt("--limit", "100"));
    if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
    const items = db.transaction(() => attemptsForVerdictReview(db, { limit, includeAiCorrect: args.includes("--include-ai-correct") })).deferred();
    const template = { schema_version: "attempt-verdict-review-v1", reviewer: "agent:<name>@<version> | human:<name>", review_version: "<review pass id>", items: items.map((a) => ({ attempt_id: a.attempt_id, expected_sequence: a.expected_sequence, verdict: "correct | incorrect", rationale: "" })) };
    out = { json: { schema_version: "attempt-verdict-export-v1", exportedAt: new Date().toISOString(), attempts: items, reviewManifestTemplate: template }, markdown: ["# Answers waiting for a decision", "", "Judge EVERY answer against its task and the approved alternatives. Return an attempt-verdict-review-v1 manifest (echo attempt_id and expected_sequence unchanged) and apply it with: npm run lab:verdicts -- apply <manifest.json>. Do not modify the database any other way.", "", ...items.flatMap((a) => [`## ${a.attempt_id}`, `session ${a.session_id} / now: ${a.current.verdict} (${a.current.source}, ${a.current.confirmation}) / expected_sequence ${a.expected_sequence}`, `task: ${a.prompt}`, `approved alternatives: ${JSON.stringify(a.accepted_answers)}`, `answer: ${JSON.stringify(a.answer)}`, ""])].join(String.fromCharCode(10)) };
  } else if (what === "vocabulary") out = exportVocabulary(db);
  else if (what === "lesson-priorities") out = exportLessonPriorities(db, new Date().toISOString(), Number(opt("--lessons", "5")));
  else out = what === "batch" ? exportBatch(db, id) : what === "session" ? exportSession(db, id) : what === "exercise" ? exportExercise(db, id) : exportCoverage(db);
  mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, id ? `${what}-${id}` : ["findings", "verdicts", "vocabulary", "lesson-priorities"].includes(what) ? what : "coverage");
  writeFileSync(`${base}.json`, JSON.stringify(out.json, null, 2));
  writeFileSync(`${base}.md`, out.markdown);
  console.log(`exported ${what}${id ? ` ${id}` : ""}\n  ${base}.json\n  ${base}.md`);
} catch (e) {
  console.error(`export failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
