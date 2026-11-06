import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createBatch, getBatch } from "../../../apps/server/src/domain/content/batches/repository.js";
import { completeBatch, completionPlanTemplate, prepareCompletion } from "../../../apps/server/src/domain/content/batches/completion.js";
import { vocabularyCoverage } from "../../../apps/server/src/domain/vocabulary/practice.js";
import { loadCandidates } from "../../../apps/server/src/domain/sessions/bank.js";
import { vocabularyReplenishment } from "../../../apps/server/src/domain/content/batches/vocabularyPlan.js";
import { replenishmentStock } from "../../../apps/server/src/domain/content/batches/stock.js";
import { assembleVocabulary } from "../../../apps/server/src/domain/content/batches/vocabularyDrafts.js";
import { exerciseIdFor } from "../../../apps/server/src/domain/content/batches/generationRunner.js";
import { taxonomyForNewRevisions } from "../../../apps/server/src/domain/content/repository.js";
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
    expect(r.model.calls).toBe(4); // unit attempt, repair, individual retry and the v7 option check of the recovered draft
    expect(vocabularyCoverage(r.env.db).available).toBe(0);
  });
  it("v7: a wrong option that the local model says also fits sends the draft back; the corrected draft goes on to review", async () => {
    const r = await makeRig();
    r.env.db.prepare("INSERT INTO vocabulary_entries(id,lemma,pos,language,surface_forms_json,learned,created_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(),"endeavour","noun","en",'["endeavour"]',0,r.deps.now().toISOString());
    const {batchId}=createBatch(r.env.db,r.deps,{count:1,mode:"adaptive",category:"vocabulary"});
    let checks=0;
    const draft=(wrong:string)=>({sentence:"The team's scientific ___ continued throughout the winter.",hint_ru:"Подумайте о начинании.",explanation_ru:"Endeavour означает начинание.",part_of_speech:"noun",sense_id:"endeavour.noun.effort",surface_form:"endeavour",sentence_ru:"Научное начинание команды продолжалось всю зиму.",word_ru:"начинание",options:[{text:"endeavour",rationale_ru:"Подходит по смыслу."},{text:wrong,rationale_ru:"Не подходит."},{text:"suitcase",rationale_ru:"Не подходит."}],correct_index:0});
    r.model.behave=((_call:number,u:Record<string,unknown>)=>{
      if(u.wrong_options){checks++;return JSON.stringify({options:(u.wrong_options as Array<{id:string;text:string}>).map(o=>({id:o.id,fits:checks===1&&o.text==="effort"}))});}
      return JSON.stringify({drafts:[draft(r.model.calls<=2?"effort":"receipt")]});
    }) as never;
    await drive(r,()=>batchJobsSettled(r,batchId));
    expect(checks).toBe(2);
    expect(getBatch(r.env.db,batchId)).toMatchObject({generationDone:true,counts:{ready_for_review:1,invalid:0}});
  });
  it("v8: wrong options mix the model's own and studied words that the local model says do not fit", async () => {
    const r = await makeRig();
    const add=(lemma:string)=>{const id=randomUUID();r.env.db.prepare("INSERT INTO vocabulary_entries(id,lemma,pos,language,surface_forms_json,learned,created_at) VALUES (?,?,?,?,?,?,?)").run(id,lemma,"unknown","en",JSON.stringify([lemma]),lemma==="endeavour"?0:1,r.deps.now().toISOString());
      r.env.db.prepare("INSERT INTO vocabulary_revisions(id,entry_id,revision,translation_ru,part_of_speech,example_en,collocations_json,source,status,user_edited,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(),id,1,"слово","noun","","[]","user","approved",1,r.deps.now().toISOString());};
    for(const w of ["endeavour","hammer","journey","budget"]) add(w);
    const {batchId}=createBatch(r.env.db,r.deps,{count:1,mode:"adaptive",category:"vocabulary"});
    const draft={sentence:"The team's scientific ___ continued throughout the winter.",hint_ru:"Подумайте о начинании.",explanation_ru:"Endeavour означает начинание.",part_of_speech:"noun",sense_id:"endeavour.noun.effort",surface_form:"endeavour",sentence_ru:"Научное начинание команды продолжалось всю зиму.",word_ru:"начинание",options:[{text:"endeavour",rationale_ru:"Подходит по смыслу."},{text:"effort",rationale_ru:"Не подходит."},{text:"suitcase",rationale_ru:"Не подходит."}],correct_index:0};
    r.model.behave=((_c:number,u:Record<string,unknown>)=>{
      if(u.wrong_options) return JSON.stringify({options:(u.wrong_options as Array<{id:string;text:string}>).map(o=>({id:o.id,fits:o.text==="journey"}))});
      return JSON.stringify({drafts:[draft]});
    }) as never;
    await drive(r,()=>batchJobsSettled(r,batchId));
    const row=r.env.db.prepare("SELECT content_json FROM exercise_revisions WHERE template_cluster LIKE 'vocab-endeavour%'").get() as {content_json:string};
    const c=JSON.parse(row.content_json) as {payload:{options:Array<{id:string;text:string}>;accepted_option_ids:string[]}};
    const texts=c.payload.options.map(o=>o.text);
    // v8 mixes the model's own options with studied words; "journey" was judged to fit and is never used, and two studied words never stand together
    expect(texts).toHaveLength(3);
    expect(texts).not.toContain("journey");
    expect(texts.filter(t=>["hammer","budget"].includes(t)).length).toBeLessThanOrEqual(1);
    expect(r.model.units.some(u=>Array.isArray((u as unknown as {wrong_options?:unknown}).wrong_options)&&JSON.stringify(u).includes("hammer"))).toBe(true);
    const unit=r.model.units.find(u=>Array.isArray((u as unknown as {items?:unknown}).items)) as unknown as {items:Array<{topic?:string;topic_ideas?:string[]}>};
    expect(unit.items[0]!.topic).toBeUndefined();
    expect(unit.items[0]!.topic_ideas).toHaveLength(3);
    expect(c.payload.options.find(o=>o.id===c.payload.accepted_option_ids[0])?.text).toBe("endeavour");
  });
  it("an agent-written batch stores the plan without any model call and accepts the agent's draft as a replacement", async () => {
    const r = await makeRig();
    r.env.db.prepare("INSERT INTO vocabulary_entries(id,lemma,pos,language,surface_forms_json,learned,created_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(),"endeavour","noun","en",'["endeavour"]',0,r.deps.now().toISOString());
    const {batchId,items,units}=createBatch(r.env.db,r.deps,{count:1,mode:"adaptive",category:"vocabulary"},{agentAuthored:true});
    expect(units).toBe(0);
    expect(r.model.calls).toBe(0);
    const batch=getBatch(r.env.db,batchId);
    expect(batch).toMatchObject({generationDone:true,counts:{invalid:items}});
    expect(()=>createBatch(r.env.db,r.deps,{count:24,mode:"adaptive",category:"grammar",trial:true},{agentAuthored:true})).toThrow("trial");
    // grammar can be agent-written as well: the same stored plan, no jobs, every item waits for the agent
    const g=createBatch(r.env.db,r.deps,{count:4,mode:"adaptive",category:"grammar"},{agentAuthored:true});
    expect(g.units).toBe(0);
    expect(getBatch(r.env.db,g.batchId)).toMatchObject({generationDone:true,counts:{invalid:g.items}});
    expect(r.model.calls).toBe(0);
    const plan=completionPlanTemplate(r.env.db,batchId) as {author:string;items:Array<Record<string,unknown>>};
    expect(plan.items[0]).toMatchObject({action:"reject",expected_revision_id:null});
    const itemPlan=batch.items![0]!.plan;
    const raw=itemPlan.vocabulary!.family==="guided_recall"
      ? {sentence:"The team's scientific ___ continued throughout the winter.",hint_ru:"Подумайте о начинании.",explanation_ru:"Endeavour означает начинание.",part_of_speech:"noun",sense_id:"1",surface_form:"endeavour",sentence_ru:"Научное начинание команды продолжалось всю зиму.",word_ru:"начинание",cue_ru:"(сущ., на e...) начинание",accepted_answers:["endeavour"]}
      : {sentence:"The team's scientific ___ continued throughout the winter.",hint_ru:"Подумайте о начинании.",explanation_ru:"Endeavour означает начинание.",part_of_speech:"noun",sense_id:"1",surface_form:"endeavour",sentence_ru:"Научное начинание команды продолжалось всю зиму.",word_ru:"начинание",options:[{text:"endeavour",rationale_ru:"Подходит по смыслу."},{text:"receipt",rationale_ru:"Не подходит."},{text:"suitcase",rationale_ru:"Не подходит."}],correct_index:0};
    const built=assembleVocabulary(raw,itemPlan,exerciseIdFor(batchId,0),{tag:"agent",digest:"agent"},taxonomyForNewRevisions(r.env.db).skills,"vocabulary-generation-v8",[]);
    if(!built.ok) throw new Error(JSON.stringify(built.issues));
    const e=built.exercise as Record<string,unknown>;
    plan.author="agent:test-author@1";
    Object.assign(plan.items[0]!,{action:"replace",reason:"written by the agent",patch:{prompt_en:e.prompt_en,hints_ru:e.hints_ru,explanation_ru:e.explanation_ru,payload:e.payload,difficulty:e.difficulty,context_level:e.context_level,template_cluster:e.template_cluster,vocabulary:e.vocabulary}});
    const packet=prepareCompletion(r.env.db,plan);
    expect(packet.items).toHaveLength(1);
    expect(packet.items[0]!.content).toMatchObject({provenance:{origin:"agent"},vocabulary:{target:{lemma:"endeavour"}}});
  });
  it("generates the three families for dictionary words, stays unapproved until review and never enters grammar selection", async () => {
    const r=await makeRig();
    expect(()=>createBatch(r.env.db,r.deps,{count:5,mode:"adaptive",category:"vocabulary"})).toThrow("dictionary");
    r.env.db.prepare("INSERT INTO vocabulary_entries(id,lemma,pos,language,surface_forms_json,learned,created_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(),"endeavour","noun","en",'["endeavour"]',0,r.deps.now().toISOString());
    expect(vocabularyReplenishment(r.env.db)).toMatchObject({deficit:5,recommended:6,targetPerWord:5});
    const {batchId}=createBatch(r.env.db,r.deps,{count:5,mode:"adaptive",category:"vocabulary"});
    expect(vocabularyReplenishment(r.env.db).deficit).toBe(5); // queued drafts are not approved stock
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
    expect(replenishmentStock(r.env.db).vocabulary).toMatchObject({available:5,low:true,plan:{words:1,deficit:0,recommended:0}});
    r.env.db.prepare("INSERT INTO vocabulary_entries(id,lemma,pos,language,surface_forms_json,learned,created_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(),"resolve","verb","en",'["resolve"]',0,r.deps.now().toISOString());
    expect(vocabularyReplenishment(r.env.db)).toMatchObject({deficit:5,recommended:6});
    const next = createBatch(r.env.db,r.deps,{count:6,mode:"adaptive",category:"vocabulary"});
    expect(getBatch(r.env.db,next.batchId).items!.every(i => i.plan.vocabulary?.lemma === "resolve")).toBe(true); // the extra starts with the word that lacks stock
    expect(getBatch(r.env.db,next.batchId).items!.slice(0,5).every(i => i.plan.vocabulary?.lemma === "resolve")).toBe(true);
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
