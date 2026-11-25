import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { makeEnv, makeSession } from "../attempts/fixtures.js";
import { startConversation, heartbeatConversation, pauseConversation } from "../../../apps/server/src/domain/conversation/repository.js";
import { conversationAnalytics, conversationInsights } from "../../../apps/server/src/domain/conversation/analytics.js";
import { registerJourneyRoutes } from "../../../apps/server/src/routes/journey.js";
import { registerSettingsRoutes } from "../../../apps/server/src/routes/settings.js";
import { registerErrorHandling } from "../../../apps/server/src/errors.js";

it("records bounded, non-overlapping conversation time across the learning-day boundary and settings", async () => {
 const env=await makeEnv(), app=Fastify(); registerErrorHandling(app); registerJourneyRoutes(app,env.db); registerSettingsRoutes(app,env.db,{now:env.deps.now});
 try {
  let now=Date.parse("2026-10-28T14:59:55Z"); const deps={now:()=>new Date(now),newId:randomUUID};
  const other=makeSession(env); env.db.prepare("INSERT INTO practice_activity_intervals VALUES (?,?,?,?,?,?,?,?)").run("overlap",other,"tab",now+2000,now+4000,"Australia/Brisbane","visible-recent-v1",new Date(now).toISOString());
  const id=startConversation(env.db,deps,"Travel","tab"); now+=10000; heartbeatConversation(env.db,deps,id,"tab"); heartbeatConversation(env.db,deps,id,"tab"); pauseConversation(env.db,deps,id,"tab");
  expect(env.db.prepare("SELECT start_ms AS start,end_ms AS end FROM conversation_activity_intervals ORDER BY start_ms").all()).toEqual([{start:now-10000,end:now-8000},{start:now-6000,end:now}]);
  vi.spyOn(Date, "now").mockReturnValue(now);
  const journey=(await app.inject({url:"/api/v1/journey"})).json(); expect(journey.totals.conversation).toBe(8000); expect(journey.todayMs.conversation).toBe(5000); expect(journey.activeDays).toBe(2); expect(journey.dailyMinutes.conversation).toBe(2.5);
  const days=(await app.inject({url:"/api/v1/journey/daily-totals"})).json().days; expect(days).toEqual([{date:"2026-10-28",ms:5000},{date:"2026-10-29",ms:5000}]);
  const settings=await app.inject({method:"POST",url:"/api/v1/settings",payload:{dailyMinutes:{grammar:15,vocabulary:10,wordLesson:5,words:5,books:10,dictation:10,conversation:3.5},dailyOrder:["grammar","vocabulary","wordLesson","words","books","dictation","conversation"]}}); expect(settings.statusCode).toBe(200);
  expect((await app.inject({url:"/api/v1/journey"})).json().dailyMinutes.conversation).toBe(3.5);
  expect(env.db.pragma("foreign_key_check")).toEqual([]);
 } finally { vi.restoreAllMocks(); await app.close(); env.cleanup(); }
});

it("keeps tentative reviews separate and retains counts after conversation text deletion",async()=>{
 const env=await makeEnv(); try {
  const now=new Date().toISOString(); env.db.prepare("INSERT INTO conversation_sessions(id,topic,status,started_at,updated_at,active_ms,answer_count) VALUES ('s','Travel','paused',?,?,5000,3)").run(now,now);
  const add=env.db.prepare("INSERT INTO conversation_messages(id,session_id,role,text,created_at) VALUES (?,'s','user',?,?)");
  add.run("a","Hello! Yes, I do.",now); add.run("b","I go there.",now); add.run("c","Maybe",now);
  const analysis=env.db.prepare("INSERT INTO conversation_analyses(message_id,status,text,created_at) VALUES (?,'ready',?,?)");
  analysis.run("a",JSON.stringify({version:"conversation-feedback-v2",ok:true}),now); analysis.run("b",JSON.stringify({version:"conversation-feedback-v2",ok:false}),now); analysis.run("c","legacy text",now);
  expect(conversationAnalytics(env.db,"all")).toMatchObject({conversations:1,answers:3,sentences:4,good:1,suggestions:1,unclassified:1,availableAnswers:3});
  expect(conversationAnalytics(env.db,"all").series).toEqual([{startedAt:now,answers:3,activeMs:5000,good:1,suggestions:1}]);
  env.db.prepare("DELETE FROM conversation_messages WHERE session_id='s'").run(); env.db.prepare("UPDATE conversation_sessions SET history_deleted=1 WHERE id='s'").run();
  expect(conversationAnalytics(env.db,"all")).toMatchObject({conversations:1,answers:3,activeMs:5000,availableAnswers:0,good:0,suggestions:0,deletedSessions:1});
  expect(conversationAnalytics(env.db,"all").series).toEqual([{startedAt:now,answers:3,activeMs:5000,good:0,suggestions:0}]);
  for (let i=0; i<21; i++) env.db.prepare("INSERT INTO conversation_sessions(id,topic,status,started_at,updated_at) VALUES (?, 'Test', 'paused', ?, ?)").run(`extra-${i}`,now,now);
  const report=conversationAnalytics(env.db,"all"); expect(report.sessions).toHaveLength(20); expect(report.series).toHaveLength(22);
 } finally { env.cleanup(); }
});

it("conversation-insights-v1 counts words, variety, time to answer and the tentative AI figures from retained answers only", async () => {
 const env=await makeEnv(); try {
  const t=(s:number)=>new Date(Date.UTC(2026,10,20,10,0,s)).toISOString();
  env.db.prepare("INSERT INTO conversation_sessions(id,topic,status,started_at,updated_at,active_ms,answer_count) VALUES ('s','Travel','paused',?,?,5000,3)").run(t(0),t(0));
  const add=env.db.prepare("INSERT INTO conversation_messages(id,session_id,role,text,created_at) VALUES (?,'s',?,?,?)");
  add.run("q1","assistant","Where did you go?",t(0)); add.run("a","user","We went to the coast last summer with friends.",t(20));
  add.run("q2","assistant","Nice!",t(30)); add.run("b","user","I go there.",t(70));
  add.run("q3","assistant","And?",t(80)); add.run("c","user","Maybe.",t(84));
  const analysis=env.db.prepare("INSERT INTO conversation_analyses(message_id,status,text,created_at) VALUES (?,'ready',?,?)");
  analysis.run("a",JSON.stringify({version:"conversation-feedback-v2",analysis:"conversation-analysis-v3",ok:true,level:"ok",cefr:"B1",issueType:"none"}),t(21));
  analysis.run("b",JSON.stringify({version:"conversation-feedback-v2",ok:false,level:"error",grammarSkillId:"past-simple"}),t(71));
  analysis.run("c",JSON.stringify({version:"conversation-feedback-v2",analysis:"conversation-analysis-v3",ok:false,level:"tip",cefr:null,issueType:"naturalness"}),t(85));
  const ins=conversationInsights(env.db,"all",Date.parse(t(100)));
  expect(ins).toMatchObject({answers:3,totalWords:13,longest:9,levels:{ok:1,tip:1,error:1},issues:{grammar:1,naturalness:1},cefr:{B1:1}});
  expect(ins.skills).toEqual([{id:"past-simple",label:"past-simple",count:1}]);
  expect(ins.perConversation[0]).toMatchObject({answers:3,replyMedianMs:20000,cefr:3,longest:9});
  env.db.prepare("UPDATE conversation_sessions SET history_deleted=1 WHERE id='s'").run();
  expect(conversationInsights(env.db,"all",Date.parse(t(100))).perConversation).toEqual([]);
 } finally { env.cleanup(); }
});
