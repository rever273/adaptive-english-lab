// npm run slice:seed - builds the NON-RELEASE vertical-slice profile (TASK_007, D20) in its own data root (var/slice by default).
// 45 hand-written exercises go through the real pipeline: register -> pending_review -> individual review -> approve -> release.
// The reviewer is recorded as an AI AGENT (agent:...), not as a human: this bank is for trying the flow, never for the first ten lessons.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadServerModule, projectRoot, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
if (!process.env.ENGLISHLAB_DATA_ROOT) process.env.ENGLISHLAB_DATA_ROOT = path.join(projectRoot, "var", "slice");

const { loadConfig } = await loadServerModule("config.js");
const { prepareDatabase } = await loadServerModule("db/prepare.js");
const repo = await loadServerModule("domain/content/repository.js");
const { REVIEW_CHECKLIST_KEYS } = await import(pathToFileURL(path.join(projectRoot, "packages", "contracts", "dist", "index.js")).href);
const { buildSliceBank, SLICE_BLUEPRINT, SLICE_REVIEWER } = await import(pathToFileURL(path.join(projectRoot, "content", "slice", "slice-bank.mjs")).href);
const { buildDiagnosticBank, buildHeldoutBank } = await import(pathToFileURL(path.join(projectRoot, "content", "slice", "diagnostic-bank.mjs")).href);

const config = loadConfig();
const { db } = await prepareDatabase(config);
const deps = { now: () => new Date(), newId: randomUUID };
const actor = { type: "agent", id: SLICE_REVIEWER.slice("agent:".length) };

let registered = 0;
let already = 0;
const toRelease = [];
// practice bank (45) + diagnostic bank (24, bank_role diagnostic) + held-out bank (8, bank_role heldout): all through the same register -> review -> release pipeline
for (const content of [...buildSliceBank(), ...buildDiagnosticBank(), ...buildHeldoutBank()]) {
  const r = repo.registerRevision(db, deps, { content, actor: { type: "agent", id: "slice-bank-author" }, reason: "hand-written slice exercise" });
  if (r.replayed) already++;
  else registered++;
  let state = repo.latestState(db, r.revisionId).status;
  if (state === "validated") {
    repo.submitForReview(db, deps, r.revisionId, actor);
    const checklist = Object.fromEntries(REVIEW_CHECKLIST_KEYS.map((k) => [k, k === "distractors_valid" || k === "no_mistake_case_correct" ? "n/a" : true]));
    if (content.type !== "detect_error") checklist.no_mistake_case_correct = "n/a";
    if (content.type === "choose_form" || content.type === "choose_missing_fragment") checklist.distractors_valid = true;
    if (content.type === "detect_error") checklist.no_mistake_case_correct = true;
    repo.submitReview(db, deps, { revisionId: r.revisionId, reviewer: SLICE_REVIEWER, reviewVersion: "slice-review-v1", contentHash: r.contentHash, checklist, verdict: "approved" });
    repo.approveRevision(db, deps, { revisionId: r.revisionId, actor, reason: "individually reviewed (agent) for the non-release slice" });
    state = "approved";
  }
  if (state === "approved" && !repo.isSelectable(db, r.revisionId)) toRelease.push(r.revisionId);
}
if (toRelease.length > 0) repo.publishRelease(db, deps, { revisionIds: toRelease, reviewer: SLICE_REVIEWER });

// blueprint: one published revision with the default first-run policy
let bp = db.prepare("SELECT id FROM blueprints WHERE stable_key = ?").get(SLICE_BLUEPRINT.key);
if (!bp) {
  bp = { id: randomUUID() };
  db.prepare("INSERT INTO blueprints(id, stable_key) VALUES (?,?)").run(bp.id, SLICE_BLUEPRINT.key);
  db.prepare("INSERT INTO blueprint_revisions(id, blueprint_id, revision, policy_json, status, reviewer, created_at) VALUES (?,?,?,?,?,?,?)").run(
    randomUUID(),
    bp.id,
    1,
    JSON.stringify(SLICE_BLUEPRINT.policy),
    "published",
    SLICE_REVIEWER,
    new Date().toISOString(),
  );
}
const n = (sql) => db.prepare(sql).get().n;
console.log(
  JSON.stringify({
    dataRoot: config.dataRoot,
    registered,
    alreadyPresent: already,
    released: toRelease.length,
    selectable: n("SELECT COUNT(*) AS n FROM selectable_revisions"),
    blueprints: n("SELECT COUNT(*) AS n FROM blueprints"),
    note: "non-release bank, reviewed by an AI agent",
  }),
);
db.close();
