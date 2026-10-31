import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { completionPlanTemplate, prepareCompletion, completeBatch } from "../../../apps/server/src/domain/content/batches/completion.js";
import { createBatch, getBatch } from "../../../apps/server/src/domain/content/batches/repository.js";
import { replenishmentStock } from "../../../apps/server/src/domain/content/batches/stock.js";
import { isSelectable } from "../../../apps/server/src/domain/content/repository.js";
import { batchJobsSettled, closeRigs, drive, makeRig, checklistAllTrue } from "./fixtures.js";
import { projectRoot } from "../helpers.js";

afterEach(closeRigs);
async function generated(n = 3) {
  const r = await makeRig();
  const { batchId } = createBatch(r.env.db, r.deps, { count: n, mode: "balanced", types: ["choose_form"] });
  await drive(r, () => batchJobsSettled(r, batchId));
  const plan = completionPlanTemplate(r.env.db, batchId);
  plan.author = "agent:repair-author@1";
  plan.items.forEach(i => { i.reason = "Individually checked"; });
  return { r, batchId, plan };
}
function reviewFor(packet: ReturnType<typeof prepareCompletion>, reviewer = "agent:independent-reviewer@1") {
  return { schema_version: "content-review-v1", reviewer, review_version: "test-final-v1", items: packet.items.map(i => ({ ordinal: i.ordinal, content_hash: i.content_hash, verdict: "approved", checklist: checklistAllTrue(), reason: "Independent test review" })) };
}
describe("agent-completed replenishment", () => {
  it("publishes reviewed originals and corrected immutable revisions, accounts for rejects, retries without changes", async () => {
    const { r, batchId, plan } = await generated();
    const original = getBatch(r.env.db, batchId).items![0]!.revisionId!;
    const c = JSON.parse((r.env.db.prepare("SELECT content_json AS c FROM exercise_revisions WHERE id = ?").get(original) as { c: string }).c);
    c.revision++;
    c.explanation_ru = "Вчера задаёт завершённое время: нужен Past Simple.";
    c.provenance = { origin: "agent", model_tag: null, model_digest: null, prompt_version: "repair-v1" };
    Object.assign(plan.items[0]!, { action: "replace", patch: { explanation_ru: c.explanation_ru } });
    plan.items[2]!.action = "reject";
    const before = r.env.db.prepare("SELECT COUNT(*) AS n FROM exercise_revisions").get();
    const packet = prepareCompletion(r.env.db, plan);
    expect(packet.items[0]!.content.revision).toBe(2);
    expect(packet.items[0]!.content.provenance.origin).toBe("agent");
    expect(r.env.db.prepare("SELECT COUNT(*) AS n FROM exercise_revisions").get()).toEqual(before);
    const input = { plan, review: reviewFor(packet) };
    const result = completeBatch(r.env.db, r.deps, input);
    expect(result).toMatchObject({ accepted: 2, corrected: 1, rejected: 1, flagged: 0, total: 3, replayed: false });
    expect(getBatch(r.env.db, batchId)).toMatchObject({ resolved: true, counts: { released: 2, rejected: 1 } });
    expect(isSelectable(r.env.db, original)).toBe(false);
    expect((r.env.db.prepare("SELECT content_json AS c FROM exercise_revisions WHERE id = ?").get(original) as { c: string }).c).not.toContain("repair-v1");
    const counts = r.env.db.prepare("SELECT (SELECT COUNT(*) FROM exercise_revisions) AS revisions, (SELECT COUNT(*) FROM content_reviews) AS reviews, (SELECT COUNT(*) FROM content_state_events) AS events").get();
    expect(completeBatch(r.env.db, r.deps, input)).toMatchObject({ replayed: true, accepted: 2 });
    expect(r.env.db.prepare("SELECT (SELECT COUNT(*) FROM exercise_revisions) AS revisions, (SELECT COUNT(*) FROM content_reviews) AS reviews, (SELECT COUNT(*) FROM content_state_events) AS events").get()).toEqual(counts);
    expect(() => completeBatch(r.env.db, r.deps, { ...input, plan: { ...plan, author: "agent:other@1" } })).toThrow("different input");
    expect(() => r.env.db.prepare("DELETE FROM batch_outcomes").run()).toThrow("append-only");
  });
  it("refuses incomplete/stale plans, changed reviews, self-review and unchecked approval without any partial writes", async () => {
    const { r, plan } = await generated(2);
    expect(() => prepareCompletion(r.env.db, { ...plan, items: plan.items.slice(1) })).toThrow("every ordinal");
    const stale = structuredClone(plan); stale.items[0]!.expected_content_hash = "0".repeat(64);
    expect(() => prepareCompletion(r.env.db, stale)).toThrow("changed");
    const packet = prepareCompletion(r.env.db, plan);
    const review = reviewFor(packet); review.items[1]!.checklist.russian_explanation = false;
    expect(() => completeBatch(r.env.db, r.deps, {plan,review})).toThrow("every applicable check");
    expect(r.env.db.prepare("SELECT COUNT(*) AS n FROM content_reviews").get()).toEqual({n:0});
    const changed = reviewFor(packet); changed.items[1]!.content_hash = "a".repeat(64);
    expect(() => completeBatch(r.env.db, r.deps, {plan,review:changed})).toThrow("final hash");
    const c = structuredClone(packet.items[0]!.content); c.revision++; c.provenance.origin = "agent";
    Object.assign(plan.items[0]!, {action:"replace", content:c});
    expect(() => completeBatch(r.env.db, r.deps, {plan,review:reviewFor(prepareCompletion(r.env.db,plan),plan.author)})).toThrow("cannot review");
  });
  it("rolls back earlier writes when the final candidate cannot be approved", async () => {
    const {r,plan} = await generated(2);
    const packet = prepareCompletion(r.env.db,plan);
    // Simulate an intervening report using the real append-only state event mechanism.
    const review=reviewFor(packet);
    // A database failure late in the transaction must undo approval of the first candidate as well.
    r.env.db.exec("CREATE TRIGGER fail_second_review BEFORE INSERT ON content_reviews WHEN NEW.revision_id = '"+plan.items[1]!.expected_revision_id+"' BEGIN SELECT RAISE(ABORT, 'simulated late failure'); END;");
    expect(()=>completeBatch(r.env.db,r.deps,{plan,review})).toThrow("simulated late failure");
    expect(r.env.db.prepare("SELECT COUNT(*) AS n FROM content_reviews").get()).toEqual({n:0});
    expect(r.env.db.prepare("SELECT COUNT(*) AS n FROM batch_completions").get()).toEqual({n:0});
    expect(getBatch(r.env.db,plan.batch_id).counts.ready_for_review).toBe(2);
  });
  it("can finish a failed batch with zero releases", async () => {
    const r=await makeRig();
    const {batchId}=createBatch(r.env.db,r.deps,{count:1,mode:"balanced",types:["choose_form"]});
    r.model.behave=()=>'{"drafts":[]}';
    await drive(r,()=>batchJobsSettled(r,batchId));
    const plan=completionPlanTemplate(r.env.db,batchId); plan.author="agent:author@1";plan.items[0]!.reason="No usable draft";
    expect(completeBatch(r.env.db,r.deps,{plan,review:{schema_version:"content-review-v1",reviewer:"agent:reviewer@1",review_version:"1",items:[]}})).toMatchObject({accepted:0,rejected:1});
    expect(getBatch(r.env.db,batchId).counts.rejected).toBe(1);
  });
  it("the CLI prepares/checks without touching DB and preserves an existing plan", async () => {
    const {r,batchId,plan}=await generated(1);
    const dbFile=path.join(r.env.scratch.root,"db","t.sqlite"), work=path.join(r.env.scratch.root,"agent-work");
    const run=(command:string)=>spawnSync(process.execPath,["scripts/content-agent.mjs",command,batchId,"--db",dbFile,"--work",work],{cwd:projectRoot,encoding:"utf8"});
    const prepared=run("prepare");expect(prepared.status,prepared.stderr).toBe(0);
    writeFileSync(path.join(work,"plan.json"),JSON.stringify(plan));
    expect(run("prepare").status).toBe(0);
    expect(JSON.parse(readFileSync(path.join(work,"plan.json"),"utf8")).author).toBe(plan.author);
    const checked=run("check");expect(checked.status,checked.stderr).toBe(0);
    expect(JSON.parse(readFileSync(path.join(work,"final-review-packet.json"),"utf8")).items).toHaveLength(1);
    expect(r.env.db.prepare("SELECT COUNT(*) AS n FROM batch_completions").get()).toEqual({n:0});
    expect(replenishmentStock(r.env.db).grammar.available).toBe(0); // unapproved drafts do not count
  });
});
