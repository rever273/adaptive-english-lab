import { describe, expect, it } from "vitest";
import { journeyProgress, stageMilestones } from "../../../apps/web/src/pages/Journey";
import { dailyOrder } from "../../../apps/web/src/pages/DailyPractice";
import type { JourneyData } from "../../../apps/web/src/api";
const d:JourneyData={version:"test",timezone:"UTC",today:"2026-11-06",totals:{grammar:125*3600000,vocabulary:0,words:0,books:0,dictation:0,wordLesson:0,conversation:0},todayMs:{grammar:0,vocabulary:0,words:0,books:0,dictation:0,wordLesson:0,conversation:0},activeDays:0,journeyHours:{b2:250,c1:300,c2:400},dailyMinutes:{grammar:15,vocabulary:10,words:5,books:10,dictation:10,wordLesson:5,conversation:0},dailyOrder:["grammar","vocabulary","wordLesson","words","books","dictation","conversation"],bookMinutes:5};
describe("journey",()=>{it("measures hours within the selected stage",()=>{expect(journeyProgress(d).stageProgress).toBe(.5);expect(journeyProgress({...d,totals:{...d.totals,grammar:400*3600000}}).stageProgress).toBe(.5);});it("uses the configured base order when all are at zero",()=>{expect(dailyOrder(d.dailyMinutes,d.todayMs,d.dailyOrder)).toEqual(d.dailyOrder.filter(m => d.dailyMinutes[m] > 0));});});

it("marks the current stage milestones and exact custom target",()=>{expect(stageMilestones(12,5)).toEqual([{hours:5,complete:true,next:false},{hours:10,complete:false,next:true},{hours:12,complete:false,next:false}]);expect(stageMilestones(10,10).every(m=>m.complete&&!m.next)).toBe(true);});

it("puts least complete first, keeps ties stable and ignores disabled modes",()=>{
 const minutes={...d.dailyMinutes,wordLesson:0,conversation:0};
 const time={...d.todayMs,grammar:450000,vocabulary:0,words:150000,books:600000,dictation:0};
 expect(dailyOrder(minutes,time,d.dailyOrder)).toEqual(["vocabulary","dictation","grammar","words","books"]);
});
it("does not label a rounded 100% as completed",()=>{
 const minutes={...d.dailyMinutes,grammar:10,vocabulary:10};
 const time={...d.todayMs,grammar:600000,vocabulary:599000,wordLesson:300000,words:300000,books:600000,dictation:600000};
 expect(dailyOrder(minutes,time,d.dailyOrder)[0]).toBe("vocabulary");
});
