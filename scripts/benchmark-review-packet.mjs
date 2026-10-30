// Prepare a blind label review packet. CPU/files only; never calls an external service or model.
import {createHash} from "node:crypto";
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import path from "node:path";
import {projectRoot} from "./_common.mjs";
const source=path.join(projectRoot,"documentation/spec/benchmark-cases.json");
const bytes=readFileSync(source);const manifest=JSON.parse(bytes);
const sha=x=>createHash("sha256").update(x).digest("hex");
const out=path.join(projectRoot,"documentation/spec/evidence/task-009/repair-20261029/label-review");mkdirSync(out,{recursive:true});
const rows=manifest.cases.map(c=>({review_id:sha(`blind-review-v1:${c.id}`).slice(0,24),text:c.text})).sort((a,b)=>a.review_id.localeCompare(b.review_id));
const packet={schema_version:"blind-label-review-v1",source_sha256:sha(bytes),status:"pending_independent_review",
  instructions:["Judge each text independently, without seeing expected labels, class-coded IDs, test split or model outputs.","Use correct/grammar_error/context_ambiguous/incomplete_input/unresolved. Ordinary grammatical dialect variants and style preferences are not errors.","For grammar_error cite the offending words, a minimal correction and a defensible rule. Preserve meaning. For ambiguity name the required context; unreadable ASR belongs to incomplete_input.","Record reviewer identity, whether you authored the case, initial label and confidence before discussion. Keep disagreements and adjudication reasons; do not resolve them by majority of correlated model outputs.","Do not inspect reference-private.json before completing the independent pass. Full project filesystem access is not a technical blindness guarantee."],cases:rows};
writeFileSync(path.join(out,"review-packet.json"),JSON.stringify(packet,null,2));
writeFileSync(path.join(out,"reference-private.json"),JSON.stringify({source_sha256:sha(bytes),role:"reference for adjudication AFTER blind pass only",items:manifest.cases.map(c=>({review_id:sha(`blind-review-v1:${c.id}`).slice(0,24),original_id:c.id,original_expected:c.expected,skill_id:c.skill_id,split:c.split,group:c.group}))},null,2));
writeFileSync(path.join(out,"review-template.json"),JSON.stringify({schema_version:"label-review-v1",source_sha256:sha(bytes),reviewer:"",authored_cases:false,independent_before_model_outputs:false,status:"pending_review",items:rows.map(r=>({review_id:r.review_id,label:null,fragment:null,correction:null,rule:null,missing_context:null,reason:null}))},null,2));
console.log(`Blind review packet: ${rows.length} cases; gold labels unchanged; no human/independent approval fabricated.`);
