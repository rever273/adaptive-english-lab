// npm run pack -- check <name>                     validate a content pack against the live bank (nothing is kept) and write the review sheet
// npm run pack -- publish <name> --review <file>   register -> ONE individual review per revision -> approve -> release, then publish blueprints
//
// A pack lives in content/packs/<name>/index.mjs and exports `pack = { name, author, items: exercise-v1[], blueprints: [{ key, policy }] }`.
// Items may be written with buildBlock() from content/first10/lib.mjs. A corrected exercise is the same id with revision + 1; on publish the older
// approved revision is flagged so it is never selected again (history stays). Publishing needs a content-review-v1 manifest with a verdict for EVERY
// item from a reviewer that is not the author (D62): nothing is approved automatically.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadServerModule, projectRoot, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const args = process.argv.slice(2);
const [cmd, name] = args;
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
if (!["check", "publish"].includes(cmd) || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(name ?? "")) {
  console.error("usage: npm run pack -- check <name> | publish <name> --review <manifest.json>");
  process.exit(2);
}
const packFile = path.join(projectRoot, "content", "packs", name, "index.mjs");
if (!existsSync(packFile)) {
  console.error(`No pack at content/packs/${name}/index.mjs`);
  process.exit(2);
}
const { pack } = await import(pathToFileURL(packFile).href);
if (!pack || !Array.isArray(pack.items) || !/^agent:\S+$/.test(pack.author ?? "")) {
  console.error("The pack must export pack = { name, author: 'agent:<model>@<version>', items: [...], blueprints: [...] }");
  process.exit(2);
}

const { loadConfig } = await loadServerModule("config.js");
const { prepareDatabase } = await loadServerModule("db/prepare.js");
const { readLock, classifyLock } = await loadServerModule("lock.js");
const repo = await loadServerModule("domain/content/repository.js");
const { BlueprintPolicySchema } = await loadServerModule("domain/sessions/policy.js");
const { computeReadiness } = await loadServerModule("domain/sessions/readiness.js");
const { REVIEW_CHECKLIST_KEYS } = await import(pathToFileURL(path.join(projectRoot, "packages", "contracts", "dist", "index.js")).href);

const config = loadConfig();
const running = readLock(config.lockPath);
if (cmd === "publish" && running && classifyLock(running) !== "stale") {
  console.error(`English Lab is running (pid ${running.pid}). Stop it first: npm stop`);
  process.exit(3);
}
const { db } = await prepareDatabase(config);
const blueprintKeys = new Set();
const lessonNumbers = new Map(db.prepare("SELECT stable_key AS key FROM blueprints").all().map((r) => [/l(\d+)$/i.exec(r.key)?.[1], r.key]).filter(([n]) => n !== undefined).map(([n, key]) => [Number(n), key]));
const activeSkills = new Set(db.prepare("SELECT skill_id AS id FROM skill_revisions WHERE active = 1 AND taxonomy_id = (SELECT id FROM taxonomy_versions ORDER BY created_at DESC, rowid DESC LIMIT 1)").all().map((r) => r.id));
for (const b of pack.blueprints ?? []) {
  const valid = BlueprintPolicySchema.safeParse(b.policy);
  if (typeof b.key !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(b.key) || blueprintKeys.has(b.key) || !valid.success || (valid.success && valid.data.skillPool.some((id) => !activeSkills.has(id)))) {
    console.error(`Invalid or duplicate blueprint ${b.key ?? "(missing key)"}`);
    db.close();
    process.exit(2);
  }
  const number = /l(\d+)$/i.exec(b.key)?.[1];
  if (number !== undefined && lessonNumbers.has(Number(number)) && lessonNumbers.get(Number(number)) !== b.key) {
    console.error(`Lesson number ${Number(number)} is already used by ${lessonNumbers.get(Number(number))}`);
    db.close();
    process.exit(2);
  }
  if (number !== undefined) lessonNumbers.set(Number(number), b.key);
  blueprintKeys.add(b.key);
}
const deps = { now: () => new Date(), newId: randomUUID };
const authorActor = { type: "agent", id: pack.author.slice("agent:".length) };
const exportsDir = path.join(config.dataRoot, "exports");
mkdirSync(exportsDir, { recursive: true });

// local checks the database cannot do: guided answers start with the given starter, no word repeated across a gap
const local = [];
for (const ex of pack.items) {
  if (ex.type === "guided_short_answer") {
    const starter = /starting with: (.+?)\.\.\.$/.exec(ex.prompt_en)?.[1];
    for (const a of starter ? ex.payload.accepted_answers : []) if (!a.toLowerCase().startsWith(starter.toLowerCase())) local.push(`${ex.id}: accepted answer "${a}" does not start with "${starter}"`);
  }
  if (ex.type === "choose_form" || ex.type === "choose_missing_fragment") {
    const [before, after] = ex.prompt_en.split("___");
    const last = (s) => (s.trim().match(/([\w']+)\W*$/) ?? [])[1]?.toLowerCase();
    const first = (s) => (s.trim().match(/^\W*([\w']+)/) ?? [])[1]?.toLowerCase();
    for (const o of ex.payload.options) {
      if (last(before ?? "") && last(before) === first(o.text)) local.push(`${ex.id}: option "${o.text}" repeats "${last(before)}" before the gap`);
      if (first(after ?? "") && first(after) === last(o.text)) local.push(`${ex.id}: option "${o.text}" repeats "${first(after)}" after the gap`);
    }
  }
}

/**
 * A pack item with revision N > 1 corrects an earlier revision. In a database that never had that exercise (a fresh install) there is nothing
 * to correct, so it is registered as that exercise's first revision; where the earlier revision exists it is registered as the next one.
 */
const forThisDb = (content) => (content.revision > 1 && !db.prepare("SELECT 1 FROM exercise_revisions WHERE exercise_id = ? LIMIT 1").get(content.id) ? { ...content, revision: 1 } : content);

/** register every item inside one transaction; on check it is rolled back, so the live bank is the reference and nothing is kept */
function registerAll() {
  const out = [];
  for (const item of pack.items) {
    const content = forThisDb(item);
    try {
      const r = repo.registerRevision(db, deps, { content, actor: authorActor, reason: `content pack ${name}` });
      out.push({ content, ...r, error: null });
    } catch (e) {
      out.push({ content, error: `${e.code ?? "ERROR"}: ${e.message}${e.details ? " " + JSON.stringify(e.details).slice(0, 600) : ""}` });
    }
  }
  return out;
}

if (cmd === "check") {
  db.exec("BEGIN");
  let results;
  try {
    results = registerAll();
  } finally {
    db.exec("ROLLBACK");
  }
  const failed = results.filter((r) => r.error);
  for (const r of failed) console.log(`INVALID ${r.content.id}: ${r.error}`);
  for (const l of local) console.log(`INVALID ${l}`);
  for (const r of results.filter((x) => !x.error && x.warnings?.length)) console.log(`warning ${r.content.id}: ${r.warnings.map((w) => w.code).join(", ")}`);
  const ok = results.filter((r) => !r.error);
  const sheet = ok.map((r) => ({ exercise_id: r.content.id, revision: r.content.revision, content_hash: r.contentHash, content: r.content }));
  writeFileSync(path.join(exportsDir, `pack-${name}-review-sheet.json`), JSON.stringify({ schema_version: "pack-review-sheet-v1", pack: name, author: pack.author, items: sheet }, null, 2));
  writeFileSync(
    path.join(exportsDir, `pack-${name}-review-template.json`),
    JSON.stringify({ schema_version: "content-review-v1", reviewer: "agent:<reviewer-model>@pack-review-v1", items: sheet.map((s) => ({ exercise_id: s.exercise_id, content_hash: s.content_hash, verdict: "", reason: "" })) }, null, 2),
  );
  console.log(JSON.stringify({ pack: name, items: pack.items.length, valid: ok.length, invalid: failed.length + local.length, reviewSheet: path.join(exportsDir, `pack-${name}-review-sheet.json`), reviewTemplate: path.join(exportsDir, `pack-${name}-review-template.json`) }));
  db.close();
  process.exit(failed.length + local.length === 0 ? 0 : 1);
}

// publish
const manifestPath = opt("--review");
if (!manifestPath || !existsSync(manifestPath)) {
  console.error("publish needs --review <content-review-v1 manifest> (run `npm run pack -- check <name>` for the template)");
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const problems = [...local];
if (manifest.schema_version !== "content-review-v1") problems.push("manifest schema_version must be content-review-v1");
if (!/^agent:\S+@\S+$/.test(manifest.reviewer ?? "")) problems.push("reviewer must be 'agent:<model>@<review-version>'");
if (manifest.reviewer?.split("@")[0] === pack.author.split("@")[0]) problems.push(`the reviewer (${manifest.reviewer}) must not be the author (${pack.author})`);
const verdicts = new Map((manifest.items ?? []).map((i) => [`${i.exercise_id}|${i.content_hash}`, i]));
if (problems.length) {
  for (const p of problems) console.error(`REFUSED ${p}`);
  process.exit(1);
}

let summary;
const publishAll = db.transaction(() => {
  const results = registerAll();
  const errs = results.filter((r) => r.error).map((r) => `${r.content.id}: ${r.error}`);
  for (const r of results.filter((x) => !x.error)) {
    const v = verdicts.get(`${r.content.id}|${r.contentHash}`);
    if (!v || !["approved", "flagged", "rejected"].includes(v.verdict) || !v.reason) errs.push(`${r.content.id}: no verdict with a reason for content hash ${r.contentHash}`);
  }
  if (errs.length) {
    const e = new Error("refused");
    e.problems = errs;
    throw e; // nothing is kept
  }
  const reviewerActor = { type: "agent", id: manifest.reviewer.slice("agent:".length) };
  const approved = [];
  const counts = { approved: 0, flagged: 0, rejected: 0, alreadyPresent: 0 };
  for (const r of results) {
    if (r.replayed) {
      counts.alreadyPresent++;
      continue;
    }
    const v = verdicts.get(`${r.content.id}|${r.contentHash}`);
    repo.submitForReview(db, deps, r.revisionId, reviewerActor);
    const ok = v.verdict === "approved";
    const checklist = Object.fromEntries(REVIEW_CHECKLIST_KEYS.map((k) => [k, ok]));
    if (ok) {
      checklist.distractors_valid = r.content.type === "choose_form" || r.content.type === "choose_missing_fragment" || r.content.type === "context_reading" ? true : "n/a";
      checklist.no_mistake_case_correct = r.content.type === "detect_error" ? true : "n/a";
    }
    repo.submitReview(db, deps, { revisionId: r.revisionId, reviewer: manifest.reviewer, reviewVersion: "pack-review-v1", contentHash: r.contentHash, checklist, verdict: v.verdict });
    if (ok) {
      repo.approveRevision(db, deps, { revisionId: r.revisionId, actor: reviewerActor, reason: `pack ${name}: ${v.reason}`.slice(0, 500) });
      approved.push(r);
    } else if (v.verdict === "rejected") repo.rejectRevision(db, deps, { revisionId: r.revisionId, actor: reviewerActor, reason: v.reason });
    else repo.flagRevision(db, deps, { revisionId: r.revisionId, actor: reviewerActor, reason: v.reason });
    counts[v.verdict]++;
  }
  if (approved.length) repo.publishRelease(db, deps, { revisionIds: approved.map((r) => r.revisionId), reviewer: manifest.reviewer });
  // a corrected revision replaces the older approved one in selection; the old one and its history stay
  let superseded = 0;
  for (const r of approved.filter((x) => x.revision > 1)) {
    const older = db.prepare("SELECT id FROM exercise_revisions WHERE exercise_id = ? AND revision < ?").all(r.exerciseId, r.revision);
    for (const o of older) {
      if (repo.latestState(db, o.id)?.status !== "approved") continue;
      repo.flagRevision(db, deps, { revisionId: o.id, actor: reviewerActor, reason: `superseded by revision ${r.revision} (pack ${name})` });
      superseded++;
    }
  }
  let blueprints = 0;
  for (const b of pack.blueprints ?? []) {
    const existing = db.prepare("SELECT id FROM blueprints WHERE stable_key = ?").get(b.key);
    const bpId = existing?.id ?? randomUUID();
    if (!existing) db.prepare("INSERT INTO blueprints(id, stable_key) VALUES (?,?)").run(bpId, b.key);
    const last = db.prepare("SELECT revision, policy_json AS p FROM blueprint_revisions WHERE blueprint_id = ? ORDER BY revision DESC LIMIT 1").get(bpId);
    if (last && last.p === JSON.stringify(b.policy)) continue;
    db.prepare("INSERT INTO blueprint_revisions(id, blueprint_id, revision, policy_json, status, reviewer, created_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), bpId, (last?.revision ?? 0) + 1, JSON.stringify(b.policy), "published", manifest.reviewer, new Date().toISOString());
    blueprints++;
  }
  summary = { pack: name, ...counts, superseded, blueprintsPublished: blueprints };
});
try {
  publishAll.immediate();
} catch (e) {
  for (const p of e.problems ?? [`${e.code ?? "ERROR"}: ${e.message}`]) console.error(`REFUSED ${p}`);
  console.error("Nothing was published.");
  db.close();
  process.exit(1);
}

const readiness = {};
for (const b of pack.blueprints ?? []) {
  const row = db.prepare("SELECT br.id FROM blueprint_revisions br JOIN blueprints bp ON bp.id = br.blueprint_id WHERE bp.stable_key = ? ORDER BY br.revision DESC LIMIT 1").get(b.key);
  if (row) readiness[b.key] = computeReadiness(db, deps, row.id).readySessions;
}
console.log(JSON.stringify({ ...summary, readySessions: readiness }));
db.close();
