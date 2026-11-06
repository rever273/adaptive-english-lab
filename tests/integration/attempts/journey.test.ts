import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerJourneyRoutes, allocateDays, learningDate } from "../../../apps/server/src/routes/journey.js";
import { recordPracticeActivity } from "../../../apps/server/src/domain/sessions/activity.js";
import { takeLease } from "../../../apps/server/src/domain/sessions/lease.js";
import { registerErrorHandling } from "../../../apps/server/src/errors.js";
import { registerSettingsRoutes } from "../../../apps/server/src/routes/settings.js";
import { makeEnv, makeSession, type Env } from "./fixtures.js";
let env:Env; beforeEach(async()=>{env=await makeEnv();}); afterEach(()=>env.cleanup());
describe("journey data",()=>{
 it("changes the Brisbane learning day at 01:00 and splits an interval at the boundary",()=>{
  const before=Date.parse("2026-10-28T14:59:55Z"),after=Date.parse("2026-10-28T15:00:05Z");
  expect(learningDate(Date.parse("2026-10-28T14:00:00Z"))).toBe("2026-10-28");
  expect(learningDate(Date.parse("2026-10-28T14:59:59.999Z"))).toBe("2026-10-28");
  expect(learningDate(Date.parse("2026-10-28T15:00:00Z"))).toBe("2026-10-29");
  expect(allocateDays(before,after,"Australia/Brisbane")).toEqual([{date:"2026-10-28",ms:5000},{date:"2026-10-29",ms:5000}]);
 });
 it("rolls today and its activity together at 01:00 Brisbane while preserving lifetime totals",async()=>{
  const a=Fastify();registerErrorHandling(a);registerJourneyRoutes(a,env.db);
  try {
   const session=makeSession(env);const start=Date.parse("2026-10-28T14:59:55Z"),end=start+10000;
   env.db.prepare("INSERT INTO practice_activity_intervals VALUES (?,?,?,?,?,?,?,?)").run("boundary",session,"tab",start,end,"Australia/Brisbane","visible-recent-v1",new Date(start).toISOString());
   vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-28T14:59:59Z"));
   const before=(await a.inject({url:"/api/v1/journey?timezone=UTC"})).json();
   expect(before).toMatchObject({version:"journey-v2",timezone:"Australia/Brisbane",today:"2026-10-28",todayMs:{grammar:5000},totals:{grammar:10000}});
   vi.setSystemTime(new Date("2026-10-28T15:00:01Z"));
   const after=(await a.inject({url:"/api/v1/journey?timezone=UTC"})).json();
   expect(after).toMatchObject({today:"2026-10-29",todayMs:{grammar:5000},totals:{grammar:10000},activeDays:2});
  } finally {vi.useRealTimers();await a.close();}
 });
 it("deduplicates typing observations without adding them to lifetime counters twice",async()=>{
  const a=Fastify();registerErrorHandling(a);registerJourneyRoutes(a,env.db);try{
   const now=Date.now();env.db.prepare("INSERT INTO typing_sessions(id,mode,status,level_number,settings_revision,settings_json,plan_json,started_at,active_ms) VALUES (?,?,?,?,?,?,?,?,?)").run("typing-1","words","active",1,1,"{}","{}",new Date(now-60000).toISOString(),2000);
   const payload={id:"8a8f7408-580f-42a0-bf35-3f1714ff1222",sessionId:"typing-1",mode:"words",startMs:now-5000,endMs:now};
   const send=()=>a.inject({method:"POST",url:"/api/v1/journey/typing-interval",payload});expect((await send()).json()).toEqual({recorded:true});expect((await send()).json()).toEqual({recorded:false});
   const result=(await a.inject({url:"/api/v1/journey?timezone=Australia%2FBrisbane"})).json();expect(result.totals.words).toBe(5000);expect(result.todayMs.words).toBe(5000);
   env.db.prepare("UPDATE typing_sessions SET active_ms=12000 WHERE id='typing-1'").run(); expect((await a.inject({url:"/api/v1/journey?timezone=Australia%2FBrisbane"})).json().totals.words).toBe(12000);
   expect((await a.inject({method:"POST",url:"/api/v1/journey/typing-interval",payload:{...payload,id:"8a8f7408-580f-42a0-bf35-3f1714ff1223"}})).statusCode).toBe(409);
  }finally{await a.close();}
 });
 it("rejects overlapping grammar and typing time",async()=>{
  const a=Fastify();registerErrorHandling(a);registerJourneyRoutes(a,env.db);try{
   env.clock.current=new Date(Date.now()-10000);const s=makeSession(env);takeLease(env.db,env.deps,s,"tab");const start=env.clock.current.getTime();env.clock.current=new Date(start+5000);
   env.db.prepare("INSERT INTO typing_sessions(id,mode,status,level_number,settings_revision,settings_json,plan_json,started_at,active_ms) VALUES (?,?,?,?,?,?,?,?,?)").run("typing-2","words","active",1,1,"{}","{}",new Date(start).toISOString(),0);
   const payload={id:"8a8f7408-580f-42a0-bf35-3f1714ff1224",sessionId:"typing-2",mode:"words",startMs:start,endMs:start+5000};expect((await a.inject({method:"POST",url:"/api/v1/journey/typing-interval",payload})).statusCode).toBe(200);
   expect(()=>recordPracticeActivity(env.db,env.deps,s,{id:"8a8f7408-580f-42a0-bf35-3f1714ff1225",tabId:"tab",startMs:start,endMs:start+5000})).toThrow(/overlaps/);
  }finally{await a.close();}
 });
 it("keeps grammar and vocabulary separate and saves settings as a revision",async()=>{const a=Fastify();registerErrorHandling(a);registerJourneyRoutes(a,env.db);registerSettingsRoutes(a,env.db,{now:env.deps.now});try{
 const g=makeSession(env),v=makeSession(env); env.db.prepare("INSERT INTO vocabulary_sessions VALUES (?,?)").run(v,env.clock.current.toISOString());
 const now=Date.now();env.db.prepare("INSERT INTO practice_activity_intervals VALUES (?,?,?,?,?,?,?,?)").run("a",g,"t",now-10000,now-5000,"Australia/Brisbane","visible-recent-v1",new Date().toISOString());env.db.prepare("INSERT INTO practice_activity_intervals VALUES (?,?,?,?,?,?,?,?)").run("b",v,"t",now-5000,now,"Australia/Brisbane","visible-recent-v1",new Date().toISOString());
 const res=await a.inject({url:"/api/v1/journey?timezone=Australia%2FBrisbane"});expect(res.statusCode).toBe(200);expect(res.json().totals).toMatchObject({grammar:5000,vocabulary:5000});expect(res.json().todayMs).toMatchObject({grammar:5000,vocabulary:5000});
 const before=(env.db.prepare("SELECT COUNT(*) AS n FROM settings_revisions").get() as {n:number}).n; const update=await a.inject({method:"POST",url:"/api/v1/settings",payload:{journeyHours:{b2:250,c1:300,c2:400},dailyMinutes:{grammar:15,vocabulary:10,words:0,books:10,dictation:5}}});expect(update.statusCode).toBe(200);expect(update.json().values.dailyMinutes.words).toBe(0);expect(env.db.prepare("SELECT COUNT(*) AS n FROM settings_revisions").get()).toEqual({n:before+1});
 }finally{await a.close();}});
});
