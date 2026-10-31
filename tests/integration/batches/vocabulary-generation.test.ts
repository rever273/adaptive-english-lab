import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createBatch, getBatch } from "../../../apps/server/src/domain/content/batches/repository.js";
import { completeBatch, completionPlanTemplate, prepareCompletion } from "../../../apps/server/src/domain/content/batches/completion.js";
import { vocabularyCoverage } from "../../../apps/server/src/domain/vocabulary/practice.js";
import { loadCandidates } from "../../../apps/server/src/domain/sessions/bank.js";
import { replenishmentStock } from "../../../apps/server/src/domain/content/batches/stock.js";
import { batchJobsSettled, checklistAllTrue, closeRigs, drive, makeRig } from "./fixtures.js";
import { applyAction, enqueue, getJob } from "../../../apps/server/src/queue/jobs.js";
afterEach(closeRigs);

describe("vocabulary replenishment through the shared queue", () => {
  it("retries a failed vocabulary item individually and leaves the recovered draft for independent review", async () => {
    const r = await makeRig();
    r.env.db.prepare("INSERT INTO vocabulary_entries(id,lemma,pos,language,surface_forms_json,learned,created_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(),"endeavour","noun","en",'["endeavour"]',0,r.deps.now().toISOString());
    const {batchId}=createBatch(r.env.db,r.deps,{count:1,mode:"adaptive",category:"vocabulary"});
    r.model.behave=(call,u)=>JSON.stringify({drafts:u.items.map(()=>({sentence:call <= 2 ? "The scientific endeavour continued throughout the winter." : "The team's scientific ___ continued throughout the winter.",hint_ru:"Подумайте о начинании.",explanation_ru:"Endeavour означает начинание.",part_of_speech:"noun",sense_id:"endeavour.noun.effort",surface_form:"endeavour",sentence_ru:"Научное начинание команды продолжалось всю зиму.",word_ru:"начинание",options:[{text:"endeavour",rationale_ru:"Подходит по смыслу."},{text:"receipt",rationale_ru:"Не подходит."},{text:"suitcase",rationale_ru:"Не подходит."}],correct_index:0}))});
    await drive(r,()=>batchJobsSettled(r,batchId));
    expect(getBatch(r.env.db,batchId)).toMatchObject({generationDone:true,counts:{ready_for_review:1,invalid:0,released:0}});
    expect(r.model.calls).toBe(3);
    expect(vocabularyCoverage(r.env.db).available).toBe(0);
  });
  it("generates the three families for dictionary words, stays unapproved until review and never enters grammar selection", async () => {
    const r=await makeRig();
    expect(()=>createBatch(r.env.db,r.deps,{count:5,mode:"adaptive",category:"vocabulary"})).toThrow("dictionary");
    r.env.db.prepare("INSERT INTO vocabulary_entries(id,lemma,pos,language,surface_forms_json,learned,created_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(),"endeavour","noun","en",'["endeavour"]',0,r.deps.now().toISOString());
    const {batchId}=createBatch(r.env.db,r.deps,{count:5,mode:"adaptive",category:"vocabulary"});
    r.model.behave=(_n,u)=>JSON.stringify({drafts:u.items.map(i=>({sentence:`Despite the difficult conditions, the field team's scientific ___ continued at site ${i.ordinal} throughout the winter.`,hint_ru:"Подумайте о значении серьёзного начинания.",explanation_ru:"Endeavour здесь означает серьёзное научное начинание, требующее усилий.",part_of_speech:"noun",sense_id:"endeavour.noun.effort",surface_form:"endeavour",sentence_ru:"Несмотря на сложные условия, научная работа продолжалась всю зиму.",word_ru:"начинание",options:[{text:"endeavour",rationale_ru:"Научное начинание."},{text:"receipt",rationale_ru:"Квитанция не подходит к этому контексту."},{text:"suitcase",rationale_ru:"Чемодан не может продолжаться."}],correct_index:0,pattern:"scientific endeavour",cue_ru:"Одно слово на e: серьёзное научное начинание.",accepted_answers:["endeavour","endeavor"]}))});
    await drive(r,()=>batchJobsSettled(r,batchId));
    expect(getBatch(r.env.db,batchId)).toMatchObject({category:"vocabulary",generationDone:true,counts:{ready_for_review:5}});
    expect(vocabularyCoverage(r.env.db).available).toBe(0);
    const plan=completionPlanTemplate(r.env.db,batchId);plan.author="agent:planner@1";plan.items.forEach(i=>i.reason="Review draft");
    const packet=prepareCompletion(r.env.db,plan);
    expect(new Set(packet.items.map(i=>i.content.vocabulary?.family)).size).toBe(3);
    const review={schema_version:"content-review-v1",reviewer:"agent:independent@1",review_version:"test-v1",items:packet.items.map(i=>({ordinal:i.ordinal,content_hash:i.content_hash,verdict:"approved",checklist:checklistAllTrue(),reason:"Synthetic infrastructure fixture; not real linguistic approval"}))};
    expect(completeBatch(r.env.db,r.deps,{plan,review})).toMatchObject({accepted:5});
    expect(vocabularyCoverage(r.env.db).available).toBe(5);
    expect(loadCandidates(r.env.db,"practice")).toHaveLength(0);
    expect(replenishmentStock(r.env.db).vocabulary).toMatchObject({available:5,low:true});
  });
  it("settles cancelled generation as reviewable failure and a retry after completion cannot generate new content", async () => {
    const r=await makeRig();
    const {batchId}=createBatch(r.env.db,r.deps,{count:1,mode:"balanced",types:["choose_form"]});
    const jobId=getBatch(r.env.db,batchId).items![0]!.jobId!;
    applyAction(r.env.db,r.deps,jobId,"cancel");
    expect(getBatch(r.env.db,batchId)).toMatchObject({generationDone:true,counts:{invalid:1}});
    const plan=completionPlanTemplate(r.env.db,batchId);plan.author="agent:author@1";plan.items[0]!.reason="Cancelled and discarded";
    completeBatch(r.env.db,r.deps,{plan,review:{schema_version:"content-review-v1",reviewer:"agent:reviewer@1",review_version:"test",items:[]}});
    // The runner also sees no queued items after a completion (including redelivery).
    expect(getBatch(r.env.db,batchId)).toMatchObject({resolved:true,counts:{rejected:1}});
    const redelivered=enqueue(r.env.db,r.deps,{kind:"generation",payload:{batchId,ordinals:[0]},idempotencyKey:`redelivered:${batchId}`,batchId,priority:3}).job;
    await drive(r,()=>getJob(r.env.db,redelivered.id)?.state==="completed");
    expect(r.model.calls).toBe(0);
    expect(r.env.db.prepare("SELECT COUNT(*) AS n FROM exercise_revisions").get()).toEqual({n:0});
  });
});
