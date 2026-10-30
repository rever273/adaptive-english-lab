// npm run first10:check - read-only structural audit of the first-ten-lessons bank (TASK_017, D59): schema + semantic validation of every exercise, the
// quotas of each lesson, the diagnostic / held-out structure, and a bank-wide duplicate and near-duplicate audit. Exit 0 = clean, 1 = a problem.
// It proves STRUCTURE and uniqueness only; the correctness of every English sentence and Russian explanation is the item review's job (see the review record).
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadServerModule, projectRoot, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const { validateExercise } = await loadServerModule("domain/content/validator.js");
const { buildFirst10, LESSONS, LESSON_QUOTAS, READING_LESSONS } = await import(pathToFileURL(path.join(projectRoot, "content", "first10", "index.mjs")).href);
const taxonomy = JSON.parse(readFileSync(path.join(projectRoot, "content", "taxonomy", "taxonomy-v1.json"), "utf8"));
const family = new Map(taxonomy.skills.map((s) => [s.id, s.family]));
const skillIds = new Set(family.keys());

const { practice, diagnostic, heldout } = buildFirst10();
const problems = [];
const bad = (m) => problems.push(m);
const all = [...practice, ...diagnostic, ...heldout];

// 1. every exercise validates (schema + invariants) and is unique by id / hash
const ids = new Set();
const hashes = new Set();
const units = new Map(); // fingerprint -> first owner
for (const ex of all) {
  const key = `${ex.bank_role}/${ex.context_id}`;
  const v = validateExercise(ex, { taxonomySkillIds: skillIds });
  if (!v.ok) bad(`${key}: ${v.errors.map((e) => `${e.code} ${e.path}`).join("; ")}`);
  for (const w of v.warnings) bad(`${key}: warning ${w.code} ${w.path} ${w.message}`);
  if (ids.has(ex.id)) bad(`${key}: duplicate id`);
  ids.add(ex.id);
  if (v.contentHash) {
    if (hashes.has(v.contentHash)) bad(`${key}: duplicate content hash`);
    hashes.add(v.contentHash);
  }
  for (const u of v.units) {
    const fp = u.fingerprint ?? u.hash ?? JSON.stringify(u);
    const prior = units.get(fp);
    if (prior && prior !== key) bad(`${key}: sentence unit already used by ${prior}`);
    units.set(fp, prior ?? key);
  }
  if (ex.context_id === undefined || ex.template_cluster === undefined) bad(`${key}: missing context or template`);
}

// 1b. a guided prompt names its starter, and every accepted answer must begin with it
for (const ex of all.filter((e) => e.type === "guided_short_answer")) {
  const starter = /starting with: (.+?)...$/.exec(ex.prompt_en)?.[1];
  if (!starter) bad(`${ex.context_id}: guided prompt has no starter`);
  else for (const a of ex.payload.accepted_answers) if (!a.toLowerCase().startsWith(starter.toLowerCase())) bad(`${ex.context_id}: accepted answer "${a}" does not start with "${starter}"`);
}

// 1c. a gap filled with any option must not repeat the word next to the gap ("that ___ patience" + "patience" -> "patience patience")
for (const ex of all.filter((e) => e.type === "choose_form" || e.type === "choose_missing_fragment")) {
  const [before, after] = ex.prompt_en.split("___");
  const last = (s) => (s.trim().match(/([\w']+)\W*$/) ?? [])[1]?.toLowerCase();
  const first = (s) => (s.trim().match(/^\W*([\w']+)/) ?? [])[1]?.toLowerCase();
  for (const o of ex.payload.options) {
    if (last(before ?? "") && last(before) === first(o.text)) bad(`${ex.context_id}: option "${o.text}" repeats "${last(before)}" before the gap`);
    if (first(after ?? "") && first(after) === last(o.text)) bad(`${ex.context_id}: option "${o.text}" repeats "${first(after)}" after the gap`);
  }
}

// 2. practice quotas: 24 per lesson (6 form, 6 fragment, 6 detect with >=25% No mistake, 3 guided, 3 translate), skills from the pool, >=4 families
const byLesson = new Map();
for (const ex of practice) {
  const code = ex.id && ex.topic.split(":")[0];
  (byLesson.get(code) ?? byLesson.set(code, []).get(code)).push(ex);
}
const summary = [];
const summaryExtra = [];
for (const [code, title, pool] of LESSONS) {
  const items = byLesson.get(code) ?? [];
  const n = (t) => items.filter((e) => e.type === t).length;
  const counts = { form: n("choose_form"), fragment: n("choose_missing_fragment"), detect: n("detect_error"), guided: n("guided_short_answer"), translate: n("russian_to_english_short") };
  if (items.length < 24 || counts.form < 6 || counts.fragment < 6 || counts.detect < 6 || counts.guided < 3 || counts.translate < 3) bad(`${code}: expected at least 24 = 6/6/6/3/3, got ${items.length} = ${JSON.stringify(counts)}`);
  if (items.length > 24) summaryExtra.push(`${code}: +${items.length - 24} reserve exercises (${JSON.stringify(counts)}), added because shared skills are consumed by earlier lessons`);
  const detect = items.filter((e) => e.type === "detect_error");
  const noMistake = detect.filter((e) => e.payload.no_mistake).length;
  if (noMistake / Math.max(detect.length, 1) < 0.25) bad(`${code}: only ${noMistake} of ${detect.length} detect items are "No mistake" (need >= 25%)`);
  const skills = new Map();
  for (const e of items) {
    if (!pool.includes(e.target_skill)) bad(`${code}: ${e.context_id} uses ${e.target_skill}, which is outside the lesson pool`);
    skills.set(e.target_skill, (skills.get(e.target_skill) ?? 0) + 1);
  }
  for (const s of pool) if (!skills.has(s)) bad(`${code}: pool skill ${s} has no exercise`);
  const fams = new Map();
  for (const [s, c] of skills) fams.set(family.get(s), (fams.get(family.get(s)) ?? 0) + c);
  if (fams.size < 4) bad(`${code}: only ${fams.size} families in the pool (need >= 4)`);
  // a session takes 18 of 24 with at most ceil(.35*18)=7 per family: is that still reachable?
  const reachable = [...fams.values()].reduce((a, c) => a + Math.min(c, 7), 0);
  if (reachable < 18) bad(`${code}: family cap leaves only ${reachable} reachable slots (need 18)`);
  if (READING_LESSONS.has(code) && n("context_reading") < 2) bad(`${code}: needs at least 2 reading passages (one per ready session), got ${n("context_reading")}`);
  const prod = items.filter((e) => e.dimension === "production").length;
  summary.push(`${code} ${title}: ${items.length} items, ${noMistake}/${detect.length} No mistake, ${skills.size} skills, ${fams.size} families (${[...fams].map(([f, c]) => `${f}:${c}`).join(" ")}), production ${prod}`);
}

// 3. diagnostic / held-out structure
for (const [name, bank] of [["diagnostic", diagnostic], ["heldout", heldout]]) {
  const dims = { recognition: 0, correction: 0, production: 0 };
  for (const e of bank) dims[e.dimension]++;
  if (bank.length !== 24 || dims.recognition !== 9 || dims.correction !== 9 || dims.production !== 6) bad(`${name}: expected 24 = 9/9/6, got ${bank.length} = ${JSON.stringify(dims)}`);
  if (new Set(bank.map((e) => e.target_skill)).size !== 24) bad(`${name}: the 24 exercises must cover 24 different skills`);
  if (bank.filter((e) => e.type === "detect_error" && e.payload.no_mistake).length < 3) bad(`${name}: needs at least 3 "No mistake" items (1 per block)`);
  if (bank.some((e) => e.bank_role !== name)) bad(`${name}: wrong bank_role`);
}
const dSkills = new Set(diagnostic.map((e) => e.target_skill));
if (heldout.some((e) => !dSkills.has(e.target_skill))) bad("heldout: skills must be the same 24 as the diagnostic skills");
const pooled = new Set(LESSONS.flatMap(([, , pool]) => pool));
for (const e of [...diagnostic, ...heldout]) if (!pooled.has(e.target_skill)) bad(`${e.bank_role}/${e.context_id}: ${e.target_skill} is in no lesson pool, so it could never be practised before a delayed check`);

// 4. near-duplicate audit: no two prompt/answer sentences of different exercises may be (almost) the same after normalisation
const words = (s) => new Set(String(s).toLowerCase().replace(/[^a-z' ]/g, " ").split(/\s+/).filter((w) => w.length > 2));
const sentences = [];
for (const ex of all) {
  const p = ex.payload;
  const texts = ex.type === "detect_error" ? [p.sentence] : ex.type === "choose_form" || ex.type === "choose_missing_fragment" ? [ex.prompt_en] : ex.type === "context_reading" ? [...p.paragraphs.flatMap((t) => t.split(/(?<=[.!?])s+/)), ...p.questions.map((x) => x.prompt)] : p.accepted_answers.slice(0, 1);
  for (const t of texts) sentences.push({ key: `${ex.bank_role}/${ex.context_id}`, w: words(t), t });
}
let near = 0;
for (let i = 0; i < sentences.length; i++) {
  for (let j = i + 1; j < sentences.length; j++) {
    const a = sentences[i];
    const b = sentences[j];
    let inter = 0;
    for (const w of a.w) if (b.w.has(w)) inter++;
    const jac = inter / (a.w.size + b.w.size - inter || 1);
    if (jac >= 0.7) {
      near++;
      bad(`near-duplicate (${jac.toFixed(2)}): ${a.key} "${a.t}"  ~  ${b.key} "${b.t}"`);
    }
  }
}

console.log(summaryExtra.join(String.fromCharCode(10)));
console.log(summary.join("\n"));
console.log(`practice ${practice.length}, diagnostic ${diagnostic.length}, heldout ${heldout.length}; distinct sentence units ${units.size}; near-duplicate pairs ${near}`);
if (problems.length > 0) {
  console.error(`PROBLEMS (${problems.length}):\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("OK: structure, quotas, uniqueness and near-duplicate audit are clean (this does not prove the English is correct - see the item review).");
