import { describe, expect, it } from "vitest";
import { buildGrammarBenchmarkUserMessage, buildAnalysisUserMessageV2, offsetReference, type AnalysisContext } from "../../../apps/server/src/domain/ai/prompts.js";
import { isSchemaValidOutput, validateAiOutput } from "../../../apps/server/src/domain/ai/validate.js";
import { scoreModel, type BenchCase, type CaseResult } from "../../../apps/server/src/domain/ai/benchmark.js";

const text = "The project reduce water use.";
const check = { attemptId: "a", submittedText: text, allowedSkillIds: new Set(["agreement.third_person"]) };
const out = (changes: Record<string,unknown> = {}) => JSON.stringify({ schema_version:"analysis-v2",attempt_id:"a",judgement:"incorrect_candidate",reason_code:"grammar_violation",missing_context:null,findings:[{skill_id:"agreement.third_person",kind:"grammar",start:12,end:18,original:"reduce",suggestion:"reduces",explanation_ru:"Singular subject requires reduces.",confidence:.9}],explanation_ru:"Subject-verb agreement.",...changes });

describe("analysis-v2 repairs the semantic contract without promoting model authority",()=>{
  it("accepts a specific evidenced error and preserves strict quote/offset binding",()=>{
    expect(validateAiOutput(out(),"analysis-v2",check).ok).toBe(true);
    const parsed=JSON.parse(out());parsed.findings[0].start=11;
    const bad=JSON.stringify(parsed);
    expect(isSchemaValidOutput(bad,"analysis-v2")).toBe(true);
    const r=validateAiOutput(bad,"analysis-v2",check);
    expect(r.ok).toBe(false);
    expect(r.issues.map(x=>x.code)).toContain("SPAN_QUOTE");
  });
  it("rejects ambiguous + grammar finding instead of counting it as valid abstention",()=>{
    const r=validateAiOutput(out({judgement:"ambiguous",reason_code:"context_required",missing_context:"Intent?"}),"analysis-v2",check);
    expect(r.ok).toBe(false);
    expect(r.issues.map(x=>x.code)).toContain("INCONSISTENT");
  });
  it("requires a real context question for ambiguity and consistent reason codes",()=>{
    expect(validateAiOutput(out({judgement:"ambiguous",reason_code:"context_required",missing_context:"Which previously mentioned object?",findings:[]}),"analysis-v2",check).ok).toBe(true);
    expect(validateAiOutput(out({judgement:"ambiguous",reason_code:"context_required",missing_context:null,findings:[]}),"analysis-v2",check).ok).toBe(false);
    expect(validateAiOutput(out({judgement:"acceptable",reason_code:"grammar_violation",findings:[]}),"analysis-v2",check).ok).toBe(false);
    expect(validateAiOutput(out({judgement:"abstain",reason_code:"incomplete_input",findings:[],missing_context:"Unreadable verb"}),"analysis-v2",check).ok).toBe(true);
  });
  it("never accepts confirmed/status/score authority from the model",()=>{
    expect(validateAiOutput(out({confirmed:true}),"analysis-v2",check).ok).toBe(false);
  });
  it("handles emoji offsets in reference tables and never sends benchmark labels/target skills",()=>{
    expect(offsetReference("😀 We works.")).toEqual([{text:"😀",start:0,end:1},{text:"We",start:2,end:4},{text:"works.",start:5,end:11}]);
    const msg=buildGrammarBenchmarkUserMessage("opaque-id",text,["agreement.third_person"]);
    const data=JSON.parse(msg.slice(msg.indexOf("{")));
    expect(Object.keys(data).sort()).toEqual(["allowed_skill_ids","attempt_id","offset_reference","submitted_text"]);
    expect(data).not.toHaveProperty("target_skill");expect(data).not.toHaveProperty("expected");
    const ctx:AnalysisContext={attemptId:"a",exerciseRevisionId:"e",contentHash:"hash",prompt:"A neutral prompt",meaning:"A neutral meaning",rubric:{target_markers:[],acceptable_variation_ru:"yes",reject_conditions_ru:"grammar"},submittedText:text,targetSkill:"agreement.third_person",additionalSkills:[],transcriptEdited:false,allowedSkillIds:["agreement.third_person"]};
    expect(buildAnalysisUserMessageV2(ctx)).toContain('"offset_reference"');
  });
});

const makeCase=(id:string,expected:BenchCase["expected"],split:BenchCase["split"]):BenchCase=>({id,expected,split,group:id,topic:"neutral",text:"A test sentence.",skill_id:"agreement.third_person"});
const result=(c:BenchCase,predicted:CaseResult["predicted"]):CaseResult=>({caseId:c.id,model:"model",run:0,phase:"warm",predicted,skills:[],validBeforeRepair:true,validAfterRepair:true,latencyMs:1,loadMs:0,evalTokens:1,evalMs:1,rawJudgement:predicted});
describe("benchmark avoids leakage and statistical pseudo-replication",()=>{
  const cases=[makeCase("d1","correct","development"),makeCase("d2","grammar_error","development"),makeCase("d3","ambiguous","development"),makeCase("h1","correct","heldout"),makeCase("h2","grammar_error","heldout"),makeCase("h3","ambiguous","heldout")];
  it("passing development cannot rescue a failing heldout and schema validity is not semantic validity",()=>{
    const rows=cases.map(c=>result(c,c.expected==="correct"?"accept":c.expected==="grammar_error"?"flag":"abstain"));
    rows[3]!.predicted="flag";rows[4]!.predicted="abstain";
    rows[5]!.validBeforeRepair=false;rows[5]!.schemaValidBeforeRepair=true;
    const score=scoreModel("model","analysis",cases,rows);
    expect(score.gate.all).toBe(false);
    expect(score.jsonValidBeforeRepair.rate).toBe(1);
    expect(score.semanticValidBeforeRepair.rate).toBe(5/6);
    expect(score.errorAbstention.k).toBe(1);
    expect(score.perSplit.heldout.grammarRecall.rate).toBe(0);
  });
  it("rejects duplicate/missing/mixed model results instead of inflating independent n",()=>{
    const rows=cases.map(c=>result(c,"accept"));
    expect(()=>scoreModel("model","analysis",cases,[...rows,rows[0]!])).toThrow(/distinct/);
    expect(()=>scoreModel("model","analysis",cases,rows.slice(1))).toThrow(/distinct/);
    rows[0]!.model="wrong";expect(()=>scoreModel("model","analysis",cases,rows)).toThrow(/one model/);
  });
});
