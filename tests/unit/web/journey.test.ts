import { describe, expect, it } from "vitest";
import { journeyProgress, stageMilestones } from "../../../apps/web/src/pages/Journey";
import { dailyOrder } from "../../../apps/web/src/pages/DailyPractice";
import type { JourneyData } from "../../../apps/web/src/api";
const d:JourneyData={version:"test",timezone:"UTC",today:"2026-11-06",totals:{grammar:125*3600000,vocabulary:0,words:0,books:0,dictation:0},todayMs:{grammar:0,vocabulary:0,words:0,books:0,dictation:0},activeDays:0,journeyHours:{b2:250,c1:300,c2:400},dailyMinutes:{grammar:15,vocabulary:10,words:5,books:10,dictation:10},dailyOrder:["grammar","vocabulary","words","books","dictation"],bookMinutes:5};
describe("journey",()=>{it("measures hours within the selected stage",()=>{expect(journeyProgress(d).stageProgress).toBe(.5);expect(journeyProgress({...d,totals:{...d.totals,grammar:400*3600000}}).stageProgress).toBe(.5);});it("rotates five unique modes by date",()=>{expect(new Set(dailyOrder("2026-11-06")).size).toBe(5);expect(dailyOrder("2026-11-06")).not.toEqual(dailyOrder("2026-11-07"));});});

it("marks the current stage milestones and exact custom target",()=>{expect(stageMilestones(12,5)).toEqual([{hours:5,complete:true,next:false},{hours:10,complete:false,next:true},{hours:12,complete:false,next:false}]);expect(stageMilestones(10,10).every(m=>m.complete&&!m.next)).toBe(true);});
