// npm run first10:seed - registers the first-ten-lessons bank (TASK_017, D59) in the regular profile (the one npm start uses; D61) through the real pipeline:
// register -> pending_review -> ONE individual review per revision -> approve -> one release, then publishes ten blueprints.
// The reviewer is recorded as an AI AGENT of the same model family that wrote the items (claude-sonnet-5-5). That is a self-review, NOT an independent strong
// review and NOT a human one (D59); the record says so. A later independent review adds its own review rows against the same hashes.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadServerModule, projectRoot, requireBuild } from "./_common.mjs";

requireBuild({ web: false });

const { loadConfig } = await loadServerModule("config.js");
const { prepareDatabase } = await loadServerModule("db/prepare.js");
const repo = await loadServerModule("domain/content/repository.js");
const { REVIEW_CHECKLIST_KEYS } = await import(pathToFileURL(path.join(projectRoot, "packages", "contracts", "dist", "index.js")).href);
const { buildFirst10, firstTenBlueprints, FIRST10_REVIEWER } = await import(pathToFileURL(path.join(projectRoot, "content", "first10", "index.mjs")).href);

const config = loadConfig();
const { readLock, classifyLock } = await loadServerModule("lock.js");
const running = readLock(config.lockPath);
if (running && classifyLock(running) !== "stale") {
  console.error(`English Lab is running (pid ${running.pid}). Stop it first: npm stop`);
  process.exit(3);
}
const { db } = await prepareDatabase(config);
const deps = { now: () => new Date(), newId: randomUUID };
const actor = { type: "agent", id: FIRST10_REVIEWER.slice("agent:".length) };
const { practice, diagnostic, heldout } = buildFirst10();

let registered = 0;
let already = 0;
const toRelease = [];
for (const content of [...practice, ...diagnostic, ...heldout]) {
  const r = repo.registerRevision(db, deps, { content, actor: { type: "agent", id: "first10-author" }, reason: "first-ten-lessons bank (TASK_017)" });
  if (r.replayed) already++;
  else registered++;
  let state = repo.latestState(db, r.revisionId).status;
  if (state === "validated") {
    repo.submitForReview(db, deps, r.revisionId, actor);
    const checklist = Object.fromEntries(REVIEW_CHECKLIST_KEYS.map((k) => [k, true]));
    checklist.distractors_valid = content.type === "choose_form" || content.type === "choose_missing_fragment" ? true : "n/a";
    checklist.no_mistake_case_correct = content.type === "detect_error" ? true : "n/a";
    repo.submitReview(db, deps, { revisionId: r.revisionId, reviewer: FIRST10_REVIEWER, reviewVersion: "first10-self-review-v1", contentHash: r.contentHash, checklist, verdict: "approved" });
    repo.approveRevision(db, deps, { revisionId: r.revisionId, actor, reason: "individually reviewed by the authoring agent family (self-review, D59); independent review still open" });
    state = "approved";
  }
  if (state === "approved" && !repo.isSelectable(db, r.revisionId)) toRelease.push(r.revisionId);
}
let releaseId = null;
if (toRelease.length > 0) releaseId = repo.publishRelease(db, deps, { revisionIds: toRelease, reviewer: FIRST10_REVIEWER });

let blueprints = 0;
for (const b of firstTenBlueprints()) {
  if (db.prepare("SELECT 1 FROM blueprints WHERE stable_key = ?").get(b.key)) continue;
  const id = randomUUID();
  db.prepare("INSERT INTO blueprints(id, stable_key) VALUES (?,?)").run(id, b.key);
  db.prepare("INSERT INTO blueprint_revisions(id, blueprint_id, revision, policy_json, status, reviewer, created_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), id, 1, JSON.stringify(b.policy), "published", FIRST10_REVIEWER, new Date().toISOString());
  blueprints++;
}
const n = (sql) => db.prepare(sql).get().n;
console.log(
  JSON.stringify({
    dataRoot: config.dataRoot,
    registered,
    alreadyPresent: already,
    released: toRelease.length,
    releaseId: releaseId?.releaseId ?? releaseId,
    selectable: n("SELECT COUNT(*) AS n FROM selectable_revisions"),
    blueprints: n("SELECT COUNT(*) AS n FROM blueprints"),
    blueprintsAdded: blueprints,
    note: "reviewed by the authoring agent family (self-review, D59); not an independent strong review",
  }),
);
db.close();
