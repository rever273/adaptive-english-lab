// CPU-only replay. Inference belongs to benchmark:ai's single GPU dispatcher.
// node scripts/nimble-tune.mjs --raw <benchmark-raw.json> [--manifest ...] [--out ...]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadServerModule, projectRoot, requireBuild } from "./_common.mjs";
requireBuild({web:false});
const arg=(key,fallback)=>process.argv.includes(key)?process.argv[process.argv.indexOf(key)+1]:fallback;
const rawPath=arg("--raw",null);
if (!rawPath) throw new Error("--raw required. Obtain model scores through benchmark:ai; no model calls here.");
const manifestPath=path.resolve(arg("--manifest",path.join(projectRoot,"documentation/spec/benchmark-cases.json")));
if (!existsSync(manifestPath)) throw new Error("Benchmark manifest not found. Supply your own reviewed cases with --manifest <file>; the private development manifest is not included in the public repository.");
const raw=JSON.parse(readFileSync(rawPath,"utf8"));
const cases=JSON.parse(readFileSync(manifestPath,"utf8")).cases;
const results=raw.models?.["nimble-v3:latest"]?.warmPasses?.[0]?.results;
if (!results) throw new Error("Raw evidence has no Nimble pass; no hidden model calls are performed");
const {exploreRoutingThresholds}=await loadServerModule("domain/ai/calibration.js");
const report=exploreRoutingThresholds(cases,results);
const out=path.resolve(arg("--out",path.join(projectRoot,"var/benchmark/routing-exploration.json")));
if (!out.startsWith(projectRoot+path.sep)) throw new Error("Output must stay in project");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out,JSON.stringify(report,null,2));
console.log(JSON.stringify({status:report.status,independentCases:report.independentCases,recommendedThreshold:report.recommendedThreshold,output:out},null,2));
