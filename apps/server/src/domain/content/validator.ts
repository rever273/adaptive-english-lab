import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DIMENSION_BY_TYPE, VocabularyPracticeMetadataSchema, normaliseVocabularyAnswer, type ExerciseType, type PromptUnitFingerprint, type ValidationIssue, type ValidationResult } from "@english-lab/contracts";
import { detectProjectRoot } from "../../config.js";
import { BLANK, contentHashOf, markBlanks } from "./normalize.js";
import { extractUnits } from "./units.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDK_TEXT = /^\s*(i\s+(do\s*not|don'?t|dunno)\s+know|idk)\s*\.?\s*$/i;

let compiled: ValidateFunction | null = null;
/** The JSON Schema lives in content/schemas/ (a drift test compares it with documentation/spec/exercise.schema.json). */
export function exerciseSchemaValidator(projectRoot = detectProjectRoot()): ValidateFunction {
  if (compiled) return compiled;
  const schema = JSON.parse(readFileSync(path.join(projectRoot, "content", "schemas", "exercise.schema.json"), "utf8")) as object;
  compiled = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  return compiled;
}

export interface ValidationContext {
  /** stable skill keys of the taxonomy revision the exercise will be stored under */
  taxonomySkillIds: ReadonlySet<string>;
}

type Opt = { id: string; text: string };

const dup = (ids: string[]): string[] => ids.filter((x, i) => ids.indexOf(x) !== i);

/**
 * Structural + semantic validation (spec/05 schema and invariants 1-7). Pure: no database, no model.
 * `ok` means "eligible for the validated state", never "correct English" and never "approved": a schema-valid
 * revision with a wrong grammar rule passes here and still needs an individual review.
 */
export function validateExercise(input: unknown, ctx: ValidationContext): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (code: string, p: string, message: string) => errors.push({ code, path: p, message });
  const warn = (code: string, p: string, message: string) => warnings.push({ code, path: p, message });

  const validate = exerciseSchemaValidator();
  if (!validate(input)) {
    for (const e of validate.errors ?? []) {
      // oneOf reports every branch; the "type" const mismatches of the other five branches are noise
      if (e.keyword === "const" && e.instancePath === "/type") continue;
      err("SCHEMA", e.instancePath || "/", `${e.message ?? "invalid"}${e.params && "additionalProperty" in e.params ? `: ${String(e.params.additionalProperty)}` : ""}`);
    }
    if (errors.length === 0) err("SCHEMA", "/", "does not match any exercise type");
    return { ok: false, errors: dedupeIssues(errors), warnings, contentHash: null, units: [] };
  }

  const ex = input as {
    id: string;
    revision: number;
    status: string;
    type: ExerciseType;
    target_skill: string;
    additional_skills: string[];
    dimension: string;
    bank_role: string;
    prompt_en: string;
    hints_ru: string[];
    explanation_ru: string;
    provenance: { origin: string; model_tag: string | null; model_digest: string | null };
    payload: Record<string, unknown>;
    vocabulary?: unknown;
  };

  // The generation gateway only ever accepts drafts: a model cannot hand in an approved/validated revision.
  if (ex.status !== "draft") err("STATUS_NOT_DRAFT", "/status", `status must be "draft" on input (got "${ex.status}"); approval is granted only by an individual review`);
  if (!UUID.test(ex.id)) err("ID_NOT_UUID", "/id", "id must be a UUID");
  if (ex.provenance.origin === "qwen" && (!ex.provenance.model_tag || !ex.provenance.model_digest)) {
    err("PROVENANCE_MODEL_MISSING", "/provenance", "qwen provenance needs model_tag and model_digest");
  }

  // dimension is a property of the format (invariant 4)
  if (ex.dimension !== DIMENSION_BY_TYPE[ex.type]) err("DIMENSION_MISMATCH", "/dimension", `${ex.type} is a ${DIMENSION_BY_TYPE[ex.type]} format, not ${ex.dimension}`);

  // taxonomy
  const skill = (id: string, p: string) => {
    if (!ctx.taxonomySkillIds.has(id)) err("UNKNOWN_SKILL", p, `skill ${id} is not in the taxonomy`);
  };
  skill(ex.target_skill, "/target_skill");
  ex.additional_skills.forEach((s, i) => {
    skill(s, `/additional_skills/${i}`);
    if (s === ex.target_skill) err("ADDITIONAL_EQUALS_TARGET", `/additional_skills/${i}`, "an additional skill must differ from the target skill");
  });

  const p = ex.payload;
  if (ex.vocabulary !== undefined) {
    const result = VocabularyPracticeMetadataSchema.safeParse(ex.vocabulary);
    if (!result.success) {
      for (const issue of result.error.issues) err("VOCABULARY_SCHEMA", `/vocabulary/${issue.path.join("/")}`, issue.message);
    } else {
      const v = result.data;
      if (ex.bank_role !== "practice") err("VOCABULARY_ROLE", "/bank_role", "Vocabulary exercises must use the practice bank");
      if (v.family === "guided_recall") {
        if (ex.type !== "guided_short_answer") err("VOCABULARY_FORMAT", "/type", "Guided recall requires guided_short_answer");
        else if (JSON.stringify(v.acceptedAnswers.map(normaliseVocabularyAnswer).sort()) !== JSON.stringify((p.accepted_answers as string[]).map(normaliseVocabularyAnswer).sort()) || v.expectedWords !== p.max_words)
          err("VOCABULARY_ANSWER_MISMATCH", "/vocabulary", "Reviewed answers and word count must match the grading payload");
      } else if (ex.type !== "choose_form" && ex.type !== "choose_missing_fragment") {
        err("VOCABULARY_FORMAT", "/type", "Vocabulary choice requires a choice format");
      } else {
        const opts = p.options as Opt[];
        const sameOptions = opts.length === v.options.length && opts.every((o) => v.options.some((x) => x.id === o.id && x.text === o.text));
        if (!sameOptions || p.multiple !== false || JSON.stringify(p.accepted_option_ids) !== JSON.stringify([v.acceptedOptionId]))
          err("VOCABULARY_ANSWER_MISMATCH", "/vocabulary", "Reviewed options and accepted answer must match the grading payload");
      }
    }
  }
  const closedChoice = (options: Opt[], accepted: string[], at: string, multiple: boolean | null) => {
    const ids = options.map((o) => o.id);
    for (const d of dup(ids)) err("DUPLICATE_ID", `${at}/options`, `option id ${d} is used twice`);
    const optIds = new Set(ids);
    for (const a of accepted) if (!optIds.has(a)) err("ACCEPTED_NOT_IN_OPTIONS", `${at}/accepted_option_ids`, `accepted id ${a} is not an option`);
    for (const d of dup(accepted)) err("DUPLICATE_ID", `${at}/accepted_option_ids`, `accepted id ${d} is listed twice`);
    if (accepted.length === 0) err("NO_ACCEPTED_OPTION", `${at}/accepted_option_ids`, "at least one accepted option is required");
    if (multiple === false && accepted.length !== 1) err("SINGLE_CHOICE_ACCEPTED_COUNT", `${at}/accepted_option_ids`, "multiple=false needs exactly one accepted option; use multiple=true when several are natural");
    if (multiple === true && accepted.length < 2) warn("MULTIPLE_WITH_ONE_ACCEPTED", `${at}/multiple`, "multiple=true but only one accepted option");
    if (accepted.length === options.length) err("ALL_OPTIONS_ACCEPTED", `${at}/accepted_option_ids`, "every option is accepted: nothing to choose");
    for (const [i, o] of options.entries()) {
      if (IDK_TEXT.test(o.text) || /^(idk|i_?dont_?know)$/i.test(o.id)) err("IDK_AS_OPTION", `${at}/options/${i}`, "\"I don't know\" is a separate UI action, never a content option");
      if (o.text.trim() !== o.text) warn("OPTION_WHITESPACE", `${at}/options/${i}`, "option text has leading/trailing whitespace");
    }
    const texts = options.map((o) => o.text.trim().toLowerCase());
    for (const t of dup(texts)) warn("DUPLICATE_OPTION_TEXT", `${at}/options`, `two options read "${t}"`);
  };

  switch (ex.type) {
    case "choose_form":
    case "choose_missing_fragment": {
      closedChoice(p.options as Opt[], p.accepted_option_ids as string[], "/payload", p.multiple as boolean);
      const blanks = (markBlanks(ex.prompt_en).split(BLANK).length - 1);
      if (ex.type === "choose_missing_fragment" && blanks !== 1) err("BLANK_COUNT", "/prompt_en", `choose_missing_fragment needs exactly one blank (___); found ${blanks}`);
      if (ex.type === "choose_form" && blanks > 1) warn("BLANK_COUNT", "/prompt_en", "more than one blank in a choose_form prompt");
      break;
    }
    case "detect_error": {
      const segs = p.segments as Opt[];
      const accepted = p.accepted_segment_ids as string[];
      const corrections = p.corrections as string[];
      const noMistake = p.no_mistake as boolean;
      for (const d of dup(segs.map((s) => s.id))) err("DUPLICATE_ID", "/payload/segments", `segment id ${d} is used twice`);
      if (segs.map((s) => s.text).join("") !== (p.sentence as string)) err("SEGMENTS_NOT_SENTENCE", "/payload/segments", "segments concatenated must equal the sentence exactly");
      const segIds = new Set(segs.map((s) => s.id));
      for (const a of accepted) if (!segIds.has(a)) err("ACCEPTED_NOT_IN_SEGMENTS", "/payload/accepted_segment_ids", `accepted id ${a} is not a segment`);
      if (noMistake) {
        if (accepted.length > 0 || corrections.length > 0) err("NO_MISTAKE_CONTRADICTION", "/payload", "no_mistake=true requires accepted_segment_ids=[] and corrections=[]");
      } else {
        if (accepted.length < 1) err("NO_ACCEPTED_SEGMENT", "/payload/accepted_segment_ids", "an erroneous sentence needs at least one accepted segment");
        if (corrections.length < 1) err("NO_CORRECTION", "/payload/corrections", "an erroneous sentence needs at least one correction");
      }
      for (const [i, s] of segs.entries()) if (IDK_TEXT.test(s.text)) err("IDK_AS_OPTION", `/payload/segments/${i}`, "\"I don't know\" is never a content segment");
      break;
    }
    case "guided_short_answer":
    case "russian_to_english_short": {
      const accepted = p.accepted_answers as string[];
      const maxWords = p.max_words as number;
      const rubric = p.rubric as { meaning_ru: string; target_markers: string[] };
      if (!/\p{Script=Cyrillic}/u.test(String(p.cue_ru))) warn("CUE_NOT_RUSSIAN", "/payload/cue_ru", "cue_ru contains no Cyrillic text");
      if (!/\p{Script=Cyrillic}/u.test(rubric.meaning_ru)) warn("RUBRIC_NOT_RUSSIAN", "/payload/rubric/meaning_ru", "meaning_ru contains no Cyrillic text");
      if (accepted.length === 0) warn("NO_ACCEPTED_ANSWERS", "/payload/accepted_answers", "no approved alternatives: every answer will be pending a model/human check");
      for (const [i, a] of accepted.entries()) {
        if (a.trim().split(/\s+/).length > maxWords) warn("ANSWER_OVER_MAX_WORDS", `/payload/accepted_answers/${i}`, "accepted answer is longer than max_words");
      }
      for (const d of dup(accepted.map((a) => a.trim().toLowerCase()))) warn("DUPLICATE_ANSWER", "/payload/accepted_answers", `answer "${d}" is listed twice`);
      break;
    }
    case "context_reading": {
      const qs = p.questions as Array<{ id: string; options: Opt[]; accepted_option_ids: string[]; target_skill: string }>;
      for (const d of dup(qs.map((q) => q.id))) err("DUPLICATE_ID", "/payload/questions", `question id ${d} is used twice`);
      qs.forEach((q, i) => {
        closedChoice(q.options, q.accepted_option_ids, `/payload/questions/${i}`, null);
        skill(q.target_skill, `/payload/questions/${i}/target_skill`);
      });
      break;
    }
  }

  if (!/\p{Script=Cyrillic}/u.test(ex.explanation_ru)) warn("EXPLANATION_NOT_RUSSIAN", "/explanation_ru", "explanation_ru contains no Cyrillic text");
  if (ex.hints_ru.some((h) => !/\p{Script=Cyrillic}/u.test(h))) warn("HINT_NOT_RUSSIAN", "/hints_ru", "a hint contains no Cyrillic text");

  const units: PromptUnitFingerprint[] = errors.length === 0 ? extractUnits({ type: ex.type, prompt_en: ex.prompt_en, payload: p }) : [];
  if (errors.length === 0 && units.length === 0) warn("NO_SENTENCE_UNITS", "/", "no full sentence units were found: no-repeat tracking cannot protect this exercise");
  return { ok: errors.length === 0, errors: dedupeIssues(errors), warnings, contentHash: errors.length === 0 ? contentHashOf(input) : null, units };
}

function dedupeIssues(list: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return list.filter((i) => {
    const k = `${i.code}|${i.path}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
