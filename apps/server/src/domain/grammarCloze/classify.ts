/**
 * Deterministic classifier: which skill does the CHOICE in this gap test? (TASK_032, grammar-cloze-classifier-v1, D143)
 * Conservative on purpose: no confident rule -> skillId null ("General Grammar"). A wrong exact label is worse than a general one.
 * Also returns risk flags for items where more than one option may be correct (they are kept out of the active set).
 */
export const CLASSIFIER_VERSION = "grammar-cloze-classifier-v1";

export interface ClozeInput {
  gappedText: string;
  solution: string;
  distractors: string[];
  filledText: string;
  sourceTopic: string;
}
export interface Classification {
  skillId: string | null;
  confidence: "exact" | "general";
  rule: string;
  riskFlags: string[];
}

const lc = (s: string): string => s.toLowerCase();
const norm = (s: string): string => lc(s).replace(/[‘’ʼ]/g, "'").replace(/\s+/g, " ").trim();
const words = (s: string): string[] => norm(s).replace(/[^a-z0-9' -]+/g, " ").split(/\s+/).filter((w) => w && w !== "-");

const IRREGULAR_PAST = new Set("was were had did went came saw took made got gave found knew thought told became left felt brought began kept held wrote stood heard let meant set met ran paid sat spoke lay led read grew lost fell sent built understood drew broke spent cut rose drove bought wore chose ate drank flew sang swam threw won taught caught sold slept forgot hid hit hurt put shut woke rode rang sank stole shook bit blew dug fed fought hung lent lit sewed shot shone slid spun spread swept swung tore wept wound".split(" "));
const BASE_IRREGULAR_PP = /^(been|done|gone|seen|taken|given|known|written|eaten|broken|spoken|driven|chosen|begun|drunk|flown|sung|swum|thrown|worn|stolen|forgotten|hidden|fallen|grown|shown|risen|ridden|torn|woken|shaken|bitten|blown|drawn|born|lost|made|had|found|told|left|felt|brought|kept|held|heard|met|paid|sat|stood|sent|built|bought|caught|taught|sold|thought|read|put|set|let|cut|hit|won)$/;

type Form = "present_continuous" | "past_continuous" | "present_perfect" | "past_perfect" | "past_simple" | "present_simple" | "future" | "other";

/** the tense of a verb group such as "has not finished" or "was cleaned" (active forms only) */
export function formOf(text: string): Form {
  const t = norm(text);
  if (/^(am|is|are|'m|'s|'re|isn't|aren't|am not|is not|are not) \w+ing$/.test(t)) return "present_continuous";
  if (/^(was|were|wasn't|weren't|was not|were not) \w+ing$/.test(t)) return "past_continuous";
  if (/^(have|has|haven't|hasn't|have not|has not|'ve) (\w+)$/.test(t) && !/^(have|has|haven't|hasn't|have not|has not|'ve) (to|been)$/.test(t)) return "present_perfect";
  if (/^(have|has|haven't|hasn't|have not|has not|'ve) been \w+ing$/.test(t)) return "other";
  if (/^(had|hadn't|had not|'d) \w+$/.test(t) && !/^(had|hadn't|had not|'d) (to|been|better|rather)$/.test(t)) return "past_perfect";
  if (/^(did|didn't|did not) \w+$/.test(t)) return "past_simple";
  if (/^(do|does|don't|doesn't|do not|does not) \w+$/.test(t)) return "present_simple";
  if (/^(will|won't|will not|'ll|shall) \w+$/.test(t)) return "future";
  if (/^\w+$/.test(t)) {
    if (/ing$/.test(t)) return "other";
    if (IRREGULAR_PAST.has(t) || /ed$/.test(t)) return "past_simple";
    if (/^(can|could|may|might|must|should|would|ought|am|is|are|was|were|will|shall|to)$/.test(t)) return "other";
    return "present_simple";
  }
  return "other";
}

const isIng = (s: string): boolean => /^\w+ing$/.test(norm(s));
const isToInf = (s: string): boolean => /^to \w+( \w+)?$/.test(norm(s));
const isBare = (s: string): boolean => /^\w+$/.test(norm(s)) && !isIng(s);

function parts(i: ClozeInput): { before: string; after: string; turnBefore: string; turnAfter: string } {
  const at = i.gappedText.indexOf("___");
  const before = i.gappedText.slice(0, at), after = i.gappedText.slice(at + 3);
  // the dialogue turn that holds the gap
  const turnBefore = before.split(/(?:^|\s)-\s+/).pop() ?? before;
  const turnAfter = after.split(/\s-\s+/)[0] ?? after;
  return { before, after, turnBefore, turnAfter };
}

const result = (skillId: string | null, rule: string, riskFlags: string[] = []): Classification => ({ skillId, confidence: skillId ? "exact" : "general", rule, riskFlags });

// ---------------------------------------------------------------------------------------------------------------- helpers per topic

const AUX_SETS: Array<[string, Set<string>]> = [
  ["agreement.be_auxiliary", new Set(["am", "is", "are", "was", "were", "'s", "'re", "'m", "isn't", "aren't", "wasn't", "weren't", "isnt", "arent"])],
  ["agreement.do_auxiliary", new Set(["do", "does", "did", "don't", "doesn't", "didn't"])],
  ["agreement.have_auxiliary", new Set(["have", "has", "had", "haven't", "hasn't", "hadn't"])],
];

/** options that differ only in an auxiliary (is/are, do/does, have/has) or in -s (third person) test agreement, whatever the tense */
function agreementSkill(i: ClozeInput): string | null {
  const opts = [i.solution, ...i.distractors].map(norm);
  const toks = opts.map((o) => o.split(" "));
  let pre = 0;
  while (toks.every((t) => t.length > pre + 1 && t[pre] === toks[0]![pre])) pre++;
  let suf = 0;
  while (toks.every((t) => t.length > pre + suf + 1 && t[t.length - 1 - suf] === toks[0]![toks[0]!.length - 1 - suf])) suf++;
  const mids = toks.map((t) => t.slice(pre, t.length - suf));
  if (mids.every((m) => m.length === 1)) {
    const firsts = mids.map((m) => m[0]!);
    for (const [skill, set] of AUX_SETS) if (firsts.every((f) => set.has(f)) && new Set(firsts).size === firsts.length) return skill;
  }
  // verb and verb+s (play / plays)
  if (opts.length === 2 || opts.length === 3) {
    const bases = opts.map((o) => o.replace(/(es|s)$/, ""));
    if (opts.every((o) => /^\w+$/.test(o)) && new Set(bases).size === 1 && opts.some((o) => /s$/.test(o)) && opts.some((o) => !/s$/.test(o))) return "agreement.third_person";
  }
  return null;
}

const MARKER = /\b(yesterday|ago|last|in (19|20)\d\d|since|for|already|yet|just|ever|never|so far|recently|lately|this (week|month|year|morning)|today|before|when|while|once|then|at (that|the) time)\b/;

function tenseSkill(i: ClozeInput, p: ReturnType<typeof parts>): Classification {
  const a = agreementSkill(i);
  if (a) return result(a, "tense.agreement");
  const sol = formOf(i.solution);
  const topic = i.sourceTopic;
  const ok = (topic === "present_simple" && sol === "present_simple") || (topic === "present_continuous" && sol === "present_continuous") || (topic === "past_simple" && sol === "past_simple") || (topic === "past_continuous" && sol === "past_continuous") || (topic === "present_perfect" && sol === "present_perfect") || (topic === "past_perfect" && sol === "past_perfect");
  if (!ok) return result(null, "tense.form_unclear");
  const differs = i.distractors.some((d) => formOf(d) !== sol);
  if (!differs) return result(null, "tense.no_contrast");
  const flags: string[] = [];
  const dForms = i.distractors.map(formOf);
  const sentence = norm(p.turnBefore + " " + i.solution + " " + p.turnAfter);
  if ((sol === "present_perfect" && dForms.includes("past_simple")) || (sol === "past_simple" && dForms.includes("present_perfect"))) if (!MARKER.test(sentence)) flags.push("perfect_vs_past_no_marker");
  return result(`tenses.${topic}`, `tense.${topic}`, flags);
}

function futureSkill(i: ClozeInput, p: ReturnType<typeof parts>): Classification {
  const a = agreementSkill(i);
  if (a) return result(a, "future.agreement");
  if (formOf(i.solution) !== "future") return result(null, "future.form_unclear");
  if (!i.distractors.some((d) => formOf(d) !== "future")) return result(null, "future.no_contrast");
  const flags: string[] = [];
  const sentence = norm(p.turnBefore + " " + i.solution + " " + p.turnAfter);
  const goingTo = [i.solution, ...i.distractors].some((o) => /\b(am|is|are|'m|'s|'re) going to\b/.test(norm(o)));
  if (goingTo && !/\b(look|decided|plans?|planning|intend|already|clouds?|evidence)\b/.test(sentence)) flags.push("future_will_going_to");
  return result("tenses.future_forms", "future.will", flags);
}

function passiveSkill(i: ClozeInput): Classification {
  const t = norm(i.solution);
  let skill: string | null = null;
  if (/^(am|is|are|'s|'re|'m|isn't|aren't|am not|is not|are not) being \w+$/.test(t) || /^(was|were|wasn't|weren't|was not|were not) being \w+$/.test(t)) skill = "passive.continuous";
  else if (/^(has|have|had|hasn't|haven't|hadn't|has not|have not|had not) been \w+$/.test(t) && !isIng(t.split(" ").pop()!)) skill = "passive.perfect";
  else if (/^(will|won't|will not|can|can't|cannot|could|couldn't|must|mustn't|should|shouldn't|may|might|would|wouldn't) (not )?be \w+$/.test(t) && !isIng(t.split(" ").pop()!)) skill = "passive.future_modal";
  else if (/^(am|is|are|isn't|aren't|am not|is not|are not) (\w+)$/.test(t) && !isIng(t.split(" ")[1]!)) skill = "passive.present";
  else if (/^(was|were|wasn't|weren't|was not|were not) (\w+)$/.test(t) && !isIng(t.split(" ")[1]!)) skill = "passive.past";
  if (skill) return result(skill, "passive.form");
  const a = agreementSkill(i);
  return result(a, a ? "passive.agreement" : "passive.unclear");
}

const IF_RE = /\b(if|unless)\b/;
type CondForm = "present" | "will" | "would" | "would_have" | "past" | "past_perfect" | "unknown";

function formInIf(text: string): CondForm {
  const t = norm(text);
  if (/\b(will|would|won't|wouldn't|'ll|'d)\b/.test(t)) return "unknown";
  if (/\b(had|hadn't)\s+(not\s+)?(been|\w+ed|\w+en|\w+n|gone|done|seen|known|taken|told|found|left|made|come|got|had|heard|read|met|paid|put|run|said|sold|sent|thought|won|worked|written)\b/.test(t)) return "past_perfect";
  if (/\b(were|was|wasn't|weren't|did|didn't|had|hadn't|\w+ed)\b/.test(t) || words(t).some((w) => IRREGULAR_PAST.has(w))) return "past";
  return "present";
}
function formInMain(text: string): CondForm {
  const t = norm(text);
  if (/\b(would|could|might|wouldn't|couldn't|'d)\s+(not\s+)?have\b/.test(t)) return "would_have";
  if (/\b(would|could|might|wouldn't|couldn't|'d)\b/.test(t)) return "would";
  if (/\b(will|won't|'ll)\b/.test(t)) return "will";
  return "present";
}

function conditionalSkill(i: ClozeInput, p: ReturnType<typeof parts>): Classification {
  const turn = (p.turnBefore + "\u0000" + p.turnAfter);
  const filledTurn = p.turnBefore + i.solution + p.turnAfter;
  if (!IF_RE.test(norm(filledTurn))) return result(null, "cond.no_if");
  const ifs = norm(filledTurn).match(/\b(if|unless)\b/g)!;
  if (ifs.length !== 1) return result(null, "cond.several_if");
  const gapAt = turn.indexOf("\u0000");
  // split the turn into the if-clause and the main clause
  const m = /\b(if|unless)\b/i.exec(filledTurn.replace(/\u0000/g, ""));
  if (!m) return result(null, "cond.no_if");
  const ifStart = m.index;
  const comma = filledTurn.indexOf(",", ifStart);
  let ifSpan: [number, number], mainSpan: [number, number];
  if (ifStart <= 2 || /^\s*$/.test(filledTurn.slice(0, ifStart))) {
    if (comma < 0) return result(null, "cond.no_comma");
    ifSpan = [ifStart, comma]; mainSpan = [comma + 1, filledTurn.length];
  } else {
    mainSpan = [0, ifStart]; ifSpan = [ifStart, filledTurn.length];
  }
  const gapStart = gapAt, gapEnd = gapAt + i.solution.length;
  const inIf = gapStart >= ifSpan[0] && gapEnd <= ifSpan[1];
  const inMain = gapStart >= mainSpan[0] && gapEnd <= mainSpan[1];
  if (inIf === inMain) return result(null, "cond.gap_position");
  if (/\bunless\b/i.test(m[0]) && false) return result(null, "cond.unless");
  const ifText = filledTurn.slice(ifSpan[0] + m[0].length, ifSpan[1]);
  const mainText = filledTurn.slice(mainSpan[0], mainSpan[1]);
  // the gap must hold the verb group itself, not the word "if"
  if (/^(if|unless)$/i.test(i.solution.trim())) return result(null, "cond.gap_is_if");
  const ifForm = inIf ? formInIf(i.solution) : formInIf(ifText);
  const mainForm = inMain ? formInMain(i.solution) : formInMain(mainText);
  if (ifForm === "unknown") return result(null, "cond.if_unclear");
  const unless = /unless/i.test(m[0]);
  let skill: string | null = null;
  if (ifForm === "present" && mainForm === "present") skill = "conditionals.zero";
  else if (ifForm === "present" && mainForm === "will") skill = "conditionals.first";
  else if (ifForm === "past" && mainForm === "would") skill = "conditionals.second";
  else if (ifForm === "past_perfect" && mainForm === "would_have") skill = "conditionals.third";
  else if ((ifForm === "past_perfect" && mainForm === "would") || (ifForm === "past" && mainForm === "would_have")) skill = "conditionals.mixed";
  if (unless && skill && skill !== "conditionals.first" && skill !== "conditionals.zero") skill = null;
  // zero conditional: an imperative or a bare modal main clause is not clearly "zero"
  if (skill === "conditionals.zero" && /\b(can|may|must|should)\b/.test(norm(mainText + " " + (inMain ? i.solution : "")))) skill = null;
  return skill ? result(skill, `cond.${skill.split(".")[1]}`) : result(null, "cond.pattern_unclear");
}

const REL = new Set(["who", "whom", "whose", "which", "that", "where", "when", "why"]);
function relativeSkill(i: ClozeInput, p: ReturnType<typeof parts>): Classification {
  const s = norm(i.solution);
  if (!REL.has(s)) return result(null, "rel.not_pronoun");
  const opts = new Set([s, ...i.distractors.map(norm)]);
  if (![...opts].every((o) => REL.has(o))) return result(null, "rel.options_mixed");
  const comma = /,\s*$/.test(p.turnBefore.trim());
  const flags: string[] = [];
  if (!comma) {
    if (opts.has("that") && opts.has("which")) flags.push("relative_that_which");
    if (opts.has("that") && (opts.has("who") || opts.has("whom"))) flags.push("relative_who_that");
  }
  return comma && s !== "that" ? result("relatives.nondefining", "rel.nondefining", flags) : result("relatives.relative_pronouns", "rel.pronoun", flags);
}

function articleSkill(i: ClozeInput): Classification {
  const s = norm(i.solution);
  if (s === "a" || s === "an") return result("articles.indefinite", "art.indefinite");
  if (s === "the") return result("articles.definite", "art.definite");
  return result(null, "art.other");
}

function modalSkill(i: ClozeInput, p: ReturnType<typeof parts>): Classification {
  const s = norm(i.solution);
  const flags: string[] = [];
  const opts = [s, ...i.distractors.map(norm)];
  const syn = (a: string, b: string): boolean => (s === a && opts.includes(b)) || (s === b && opts.includes(a));
  if (syn("must", "have to") || syn("must", "has to") || syn("can", "could") || syn("may", "might") || syn("may", "can") || syn("should", "ought to")) flags.push("modal_synonyms");
  const question = /\?/.test(p.turnAfter) || /\?\s*$/.test(norm(p.turnBefore));
  const next = words(p.turnAfter)[0];
  if (question && ["can", "could", "may", "would", "will"].includes(s)) {
    if (next === "you") return result("modals.polite_requests", "modal.request", flags);
    if (next === "i" || next === "we") return result("modals.permission", "modal.permission", flags);
    return result(null, "modal.question_unclear", flags);
  }
  if (/^(must|can't|cannot|couldn't|might|may|could) (be|have)\b/.test(s)) return result("modals.deduction", "modal.deduction", flags);
  if (["should", "shouldn't", "ought to", "oughtn't to"].includes(s)) return result("modals.advice", "modal.advice", flags);
  if (["must", "mustn't", "have to", "has to", "had to", "don't have to", "doesn't have to", "needn't", "need to", "needn't to"].includes(s)) return result("modals.obligation", "modal.obligation", flags);
  if (["can", "can't", "cannot", "could", "couldn't", "be able to", "am able to", "is able to", "are able to", "was able to"].includes(s)) return result("modals.ability", "modal.ability", flags);
  if (["may", "might"].includes(s) && !question) return result("modals.possibility", "modal.possibility", flags);
  return result(null, "modal.other", flags);
}

const TIME_NOUN = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays|january|february|march|april|may|june|july|august|september|october|november|december|spring|summer|autumn|fall|winter|night|noon|midnight|christmas|easter|weekend|weekends|weekdays|morning|mornings|afternoon|afternoons|evening|evenings|century|decade|week|month|year|\d{4}s?|\d{1,2}(:\d{2})?(am|pm)?|o'clock|\d{1,2}(st|nd|rd|th))$/;
const PLACE_NOUN = /^(home|school|work|university|college|church|hospital|airport|station|office|kitchen|park|garden|table|wall|door|floor|bed|room|house|street|shop|shops|city|town|village|country|world|corner|box|bag|car|bus|train|plane|beach|farm|shelf|window|ceiling|desk|top|bottom|front|back|cinema|restaurant|library|bank|market|gym|party|meeting|concert|wedding|stop|zoo|museum|theatre|hotel|bar|pub|cafe|centre|center|mall|supermarket|store|stage|screen|sofa|chair|couch|river|sea|lake|hill|mountain|island)$/;

function prepositionSkill(i: ClozeInput, p: ReturnType<typeof parts>): Classification {
  const s = norm(i.solution);
  const bw = words(p.turnBefore);
  const prev = bw[bw.length - 1] ?? "";
  const aw = words(p.turnAfter);
  if (s === "in" && /^interest(ed)?$/.test(prev)) return result("prepositions.interested_in", "prep.interested_in");
  if (s === "on" && /^(depend|depends|depended|depending)$/.test(prev)) return result("prepositions.depend_on", "prep.depend_on");
  if (s === "for" && /^(wait|waits|waited|waiting)$/.test(prev)) return result("prepositions.wait_for", "prep.wait_for");
  if (s === "to" && /^(listen|listens|listened|listening)$/.test(prev)) return result("prepositions.listen_to", "prep.listen_to");
  if (s === "to" && /^(explain|explains|explained|explaining)$/.test(bw[bw.length - 2] ?? "") ) return result("prepositions.explain_to", "prep.explain_to");
  if (["into", "onto", "out of", "through", "across", "towards", "toward", "along", "past"].includes(s)) return result("prepositions.movement", "prep.movement");
  if (s === "to" && /^(go|goes|went|going|gone|walk|walks|walked|walking|drive|drives|drove|driving|run|runs|ran|running|come|comes|came|coming|travel|travels|travelled|traveled|fly|flies|flew|flying|move|moves|moved|moving|return|returns|returned|get|gets|got)$/.test(prev)) return result("prepositions.movement", "prep.movement_to");
  if (["in", "on", "at"].includes(s)) {
    if (!["in", "on", "at"].every((x) => [s, ...i.distractors.map(norm)].includes(x)) && ![s, ...i.distractors.map(norm)].every((x) => ["in", "on", "at"].includes(x))) return result(null, "prep.options_mixed");
    const win = aw.slice(0, 3).filter((w) => w !== "the" && w !== "a" && w !== "an" && w !== "my" && w !== "your" && w !== "his" && w !== "her" && w !== "our" && w !== "their" && w !== "this" && w !== "that" && w !== "every" && w !== "next" && w !== "last");
    if (win.slice(0, 2).some((w) => TIME_NOUN.test(w))) return result("prepositions.time_at_on_in", "prep.time");
    if (win.slice(0, 1).some((w) => PLACE_NOUN.test(w)) || (/^\p{Lu}/u.test(p.turnAfter.trim().split(/\s+/)[0] ?? "") && !TIME_NOUN.test(aw[0] ?? ""))) return result("prepositions.place_at_on_in", "prep.place");
  }
  return result(null, "prep.other");
}

const SUBJ = new Set(["i", "he", "she", "we", "they", "you", "it"]);
const OBJ = new Set(["me", "him", "her", "us", "them", "you", "it"]);
const DET = new Set(["my", "your", "his", "her", "its", "our", "their"]);
const POSS = new Set(["mine", "yours", "his", "hers", "ours", "theirs"]);
const REFL = /(self|selves)$/;
/** pronoun FORM choices (subject / object / possessive / reflexive); used for both the personal_pronouns and possessives topics */
function pronounSkill(i: ClozeInput): Classification {
  const s = norm(i.solution);
  const opts = [s, ...i.distractors.map(norm)];
  const known = (o: string): boolean => SUBJ.has(o) || OBJ.has(o) || DET.has(o) || POSS.has(o) || REFL.test(o) || o === "whose";
  if (opts.some((o) => /(^|\w)('s|s')$/.test(o))) return result("possessives.possessive_s", "poss.s");
  if (!opts.every(known)) return result(null, "pron.other");
  if (REFL.test(s)) return result("pronouns.reflexives", "pron.reflexive");
  const plainSubjObj = (o: string): boolean => (SUBJ.has(o) || OBJ.has(o)) && !DET.has(o) && !POSS.has(o);
  const plainPoss = (o: string): boolean => (DET.has(o) || POSS.has(o) || o === "whose") && !SUBJ.has(o) && !OBJ.has(o);
  if (plainPoss(s)) return result("possessives.determiners_pronouns", "pron.possessive");
  if (plainSubjObj(s)) return result("pronouns.subject_object", "pron.subject_object");
  // ambiguous solution (her, you, it, his): decide by what the other options are
  const others = opts.slice(1);
  if (others.some((o) => plainSubjObj(o) && !REFL.test(o))) return result("pronouns.subject_object", "pron.subject_object_by_options");
  if (others.some(plainPoss)) return result("possessives.determiners_pronouns", "pron.possessive_by_options");
  return result(null, "pron.ambiguous");
}

function quantifierSkill(i: ClozeInput): Classification {
  const s = norm(i.solution);
  if (["much", "many", "too much", "too many", "so much", "so many", "how much", "how many"].includes(s)) return result("countability.much_many", "quant.much_many");
  if (["few", "a few", "little", "a little", "fewer", "less"].includes(s)) return result("countability.few_little", "quant.few_little");
  if (["some", "any", "no"].includes(s)) return result("articles.quantifiers", "quant.some_any");
  return result(null, "quant.other");
}

const NOT_EST = new Set(["interest", "forest", "west", "east", "honest", "harvest", "request", "suggest", "contest", "protest", "invest", "rest", "nest", "chest", "guest", "test", "vest", "quest", "arrest", "dentist", "artist", "modest", "digest", "manifest", "unrest", "pest", "zest", "crest", "jest", "lest", "fest", "est"]);
function comparisonSkill(i: ClozeInput, p: ReturnType<typeof parts>): Classification {
  const s = norm(i.solution);
  const sentence = norm(p.turnBefore + " " + i.solution + " " + p.turnAfter);
  const sw = s.split(" ");
  const last = sw[sw.length - 1]!;
  if (/^(the )?(most|least)\b/.test(s) || /^(the )?\w+est$/.test(s) && !NOT_EST.has(last) || /^(the )?(best|worst|furthest|farthest)$/.test(s)) return result("comparisons.superlatives", "cmp.superlative");
  if (/^as\b/.test(s) || (/\bas\b/.test(norm(p.turnBefore + " " + p.turnAfter)) && /^(as|so)$/.test(s))) return result("comparisons.as_as", "cmp.as_as");
  if (/\bthan\b/.test(sentence) && (/^(more|less)\b/.test(s) || /^\w+er$/.test(s) || /^(better|worse|further|farther)$/.test(s))) return result("comparisons.comparatives", "cmp.comparative");
  if (/^(more|less)\b/.test(s) && !/^(more|less)$/.test(s)) return result("comparisons.comparatives", "cmp.comparative_nothan");
  if (/^(better|worse|further|farther)$/.test(s) || (/^\w+er$/.test(s) && /\b(much|far|a lot|even|still)\b/.test(norm(p.turnBefore).split(" ").slice(-2).join(" ")))) return result("comparisons.comparatives", "cmp.comparative_irregular");
  return result(null, "cmp.other");
}

const WH = new Set(["who", "whom", "whose", "what", "which", "where", "when", "why", "how", "how many", "how much", "how long", "how often", "how old", "how far", "how tall", "how big", "what time", "what kind of"]);
const QAUX = new Set(["do", "does", "did", "is", "are", "was", "were", "have", "has", "had", "will", "would", "can", "could", "should", "am"]);
function whSkill(i: ClozeInput): Classification {
  const opts = [i.solution, ...i.distractors].map(norm);
  if (opts.every((o) => WH.has(o))) return result("questions.wh_words", "wh.words");
  if (opts.every((o) => QAUX.has(o))) return result("questions.direct_auxiliary", "wh.auxiliary");
  return result(null, "wh.other");
}

const VERB_BEFORE: Array<[RegExp, string, (s: string) => boolean, string]> = [
  [/\b(enjoy|enjoys|enjoyed|enjoying)\s*$/, "verb_patterns.enjoy_doing", isIng, "nf.enjoy"],
  [/\b(suggest|suggests|suggested|suggesting)\s*$/, "verb_patterns.suggest_doing", isIng, "nf.suggest"],
  [/\b(spend|spends|spent|spending)\b[^,.?!]*$/, "verb_patterns.spend_time_doing", isIng, "nf.spend"],
  [/\b(make|makes|made|making|let|lets|letting)\s+(\w+|\w+ \w+)\s*$/, "verb_patterns.make_let_bare", isBare, "nf.make_let"],
  [/\b(would rather|'d rather)\s+(\w+\s+)?(not\s+)?$/, "verb_patterns.would_rather", isBare, "nf.would_rather"],
  [/\b(think|thinks|thought|thinking)\s+(of|about)\s*$/, "verb_patterns.think_of_doing", isIng, "nf.think_of"],
  [/\b(want|wants|wanted|hope|hopes|hoped|decide|decides|decided|plan|plans|planned|need|needs|needed|would like|'d like|expect|expects|expected|promise|promised|refuse|refused|offer|offered)\s*(\w+\s+)?(not\s+)?$/, "verb_patterns.want_to", isToInf, "nf.want_to"],
];
function nonFiniteSkill(i: ClozeInput, p: ReturnType<typeof parts>): Classification {
  const s = norm(i.solution);
  const before = norm(p.turnBefore);
  if (/^(used to|be used to|get used to|am used to|is used to|are used to|got used to)$/.test(s) || /^(used to)\b/.test(s)) return result("tenses.habitual_used_to", "nf.used_to");
  if (/\b(stop|stops|stopped|stopping)\s*$/.test(before) && (isIng(s) || isToInf(s)) && i.distractors.some((d) => (isIng(d) && !isIng(s)) || (isToInf(d) && !isToInf(s)))) return result("verb_patterns.stop_doing_vs_stop_to_do", "nf.stop");
  for (const [re, skill, test, rule] of VERB_BEFORE) if (re.test(before) && test(s)) return result(skill, rule);
  const opts = [s, ...i.distractors.map(norm)];
  if (opts.some(isIng) && opts.some(isToInf) && (isIng(s) || isToInf(s))) return result("verb_patterns.gerund_or_infinitive", "nf.choice");
  return result(null, "nf.other");
}

/** classify one cleaned item */
export function classify(input: ClozeInput): Classification {
  const p = parts(input);
  switch (input.sourceTopic) {
    case "present_simple": case "present_continuous": case "past_simple": case "past_continuous": case "present_perfect": case "past_perfect": return tenseSkill(input, p);
    case "future_simple": return futureSkill(input, p);
    case "passive": return passiveSkill(input);
    case "conditionals": return conditionalSkill(input, p);
    case "relatives": return relativeSkill(input, p);
    case "articles": return articleSkill(input);
    case "modals": return modalSkill(input, p);
    case "prepositions": return prepositionSkill(input, p);
    case "personal_pronouns": case "possessives": return pronounSkill(input);
    case "quantifiers": return quantifierSkill(input);
    case "comparisons": return comparisonSkill(input, p);
    case "non_finites": return nonFiniteSkill(input, p);
    case "wh_questions": return whSkill(input);
    default: return result(null, "topic.unknown");
  }
}
