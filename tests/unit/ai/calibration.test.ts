import {describe,it,expect} from "vitest";
import {exploreRoutingThresholds} from "../../../apps/server/src/domain/ai/calibration.js";
import type {BenchCase,CaseResult} from "../../../apps/server/src/domain/ai/benchmark.js";
describe("routing exploration cannot tune on the test set",()=>{
  const cases:BenchCase[]=[{id:"dev",group:"one",topic:"topic",text:"text",expected:"grammar_error",skill_id:"skill",split:"development"},{id:"test",group:"two",topic:"topic",text:"text",expected:"correct",skill_id:"skill",split:"heldout"}];
  const result=(caseId:string,p:number):CaseResult=>({caseId,reviewProbability:p,model:"nimble",run:0,phase:"warm",predicted:"flag",skills:[],validBeforeRepair:true,validAfterRepair:true,latencyMs:1,loadMs:null,evalTokens:null,evalMs:null,rawJudgement:"review"});
  it("changing heldout scores and labels leaves calibration identical",()=>{
    const a=exploreRoutingThresholds(cases,[result("dev",.3),result("test",.9)]);
    const b=exploreRoutingThresholds([cases[0]!,{...cases[1]!,expected:"grammar_error"}],[result("dev",.3),result("test",.001)]);
    expect(a).toEqual(b);expect(a.recommendedThreshold).toBeNull();expect(a.runtimeRoutingEnabled).toBe(false);expect(a.status).toBe("insufficient_evidence");
  });
  it("refuses missing development scores and repeated samples",()=>{
    expect(()=>exploreRoutingThresholds(cases,[result("test",.3)])).toThrow(/development/);
    expect(()=>exploreRoutingThresholds(cases,[result("dev",.3),result("dev",.5)])).toThrow(/one pass/);
  });
});
