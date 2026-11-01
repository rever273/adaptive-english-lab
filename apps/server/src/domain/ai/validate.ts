import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { detectProjectRoot } from "../../config.js";

export const MAX_OUTPUT_BYTES = 64 * 1024;

export interface AnalysisFinding {
  skill_id: string;
  kind: "grammar" | "style" | "ambiguity";
  start: number;
  end: number;
  suggestion: string;
  explanation_ru: string;
  confidence: number;
}
export interface AnalysisV1 {
  schema_version: "analysis-v1";
  attempt_id: string;
  judgement: "acceptable" | "incorrect_candidate" | "ambiguous" | "abstain";
  findings: AnalysisFinding[];
  explanation_ru: string;
}
export interface AnalysisV2 extends Omit<AnalysisV1, "schema_version" | "findings"> {
  schema_version: "analysis-v2";
  reason_code: "grammatical" | "dialect_or_style" | "grammar_violation" | "context_required" | "incomplete_input" | "insufficient_evidence";
  missing_context: string | null;
  findings: Array<AnalysisFinding & { original: string }>;
}
export type AnalysisOutput = AnalysisV1 | AnalysisV2;
export interface TriageV1 {
  schema_version: "triage-v1";
  needs_deep_review: boolean;
  reason: "open_answer" | "ambiguous" | "possible_error" | "no_issue" | "unsupported";
  skill_candidates: string[];
}
export type AiOutput = AnalysisOutput | TriageV1;

export interface ValidationIssue {
  code: string;
  message: string;
}
export type Validated<T> = { ok: true; value: T; issues: [] } | { ok: false; value: null; issues: ValidationIssue[] };

let compiled: ValidateFunction | null = null;
function schemaValidator(): ValidateFunction {
  if (compiled) return compiled;
  const schema = JSON.parse(readFileSync(path.join(detectProjectRoot(), "content", "schemas", "ai-output.schema.json"), "utf8")) as object;
  compiled = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  return compiled;
}

/** The JSON Schema variant of one output kind, as it is given to the model (`format`) and hashed into prompt_versions. */
export function schemaVariant(kind: "analysis-v1" | "analysis-v2" | "triage-v1" | "vocabulary-v1" | "vocabulary-v2" | "vocabulary-v3" | "tutor-v1"): object {
  const all = JSON.parse(readFileSync(path.join(detectProjectRoot(), "content", "schemas", "ai-output.schema.json"), "utf8")) as { oneOf: Array<{ properties: { schema_version: { const: string } } }> };
  const v = all.oneOf.find((o) => o.properties.schema_version.const === kind);
  if (!v) throw new Error(`no schema variant ${kind}`);
  return v;
}

export const codePointLength = (s: string): number => Array.from(s).length;

/** Code-point offset -> JS UTF-16 index, for slicing/highlighting in the UI (emoji and astral characters take two UTF-16 units). */
export function codePointToUtf16(text: string, cp: number): number {
  let units = 0;
  let i = 0;
  for (const ch of text) {
    if (i === cp) return units;
    units += ch.length;
    i++;
  }
  if (i === cp) return units;
  throw new RangeError(`code point offset ${cp} is outside the text`);
}

export interface AnalysisCheck {
  attemptId: string;
  submittedText: string;
  allowedSkillIds: ReadonlySet<string>;
}
export interface TriageCheck {
  allowedSkillIds: ReadonlySet<string>;
}

/**
 * Strict validation of model output (spec/06): the WHOLE text must be one JSON document (no extracting a `{}` from prose),
 * <= 64 KiB, schema-valid (additionalProperties=false, so a model cannot add `confirmed`/`mastery`/`status`), known skill IDs,
 * the exact attempt id, spans inside the text, and internally consistent. Valid means validated draft - never approved or correct.
 */
export function validateAiOutput(rawText: string, kind: "analysis-v1", check: AnalysisCheck): Validated<AnalysisV1>;
export function validateAiOutput(rawText: string, kind: "analysis-v2", check: AnalysisCheck): Validated<AnalysisV2>;
export function validateAiOutput(rawText: string, kind: "triage-v1", check: TriageCheck): Validated<TriageV1>;
export function validateAiOutput(rawText: string, kind: "analysis-v1" | "analysis-v2" | "triage-v1", check: AnalysisCheck | TriageCheck): Validated<AiOutput> {
  const issues: ValidationIssue[] = [];
  const bad = (code: string, message: string) => issues.push({ code, message });
  if (Buffer.byteLength(rawText, "utf8") > MAX_OUTPUT_BYTES) return { ok: false, value: null, issues: [{ code: "TOO_LARGE", message: "model output exceeds 64 KiB" }] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, value: null, issues: [{ code: "NOT_JSON", message: "output is not a single JSON document" }] };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, value: null, issues: [{ code: "NOT_OBJECT", message: "output must be a JSON object" }] };

  const validate = schemaValidator();
  if (!validate(parsed)) {
    for (const e of validate.errors ?? []) {
      if (e.keyword === "const" && e.instancePath === "/schema_version") continue; // other oneOf branches
      bad("SCHEMA", `${e.instancePath || "/"} ${e.message ?? "invalid"}${e.params && "additionalProperty" in e.params ? `: ${String(e.params.additionalProperty)}` : ""}`);
    }
    if (issues.length === 0) bad("SCHEMA", "does not match any ai-output variant");
    return { ok: false, value: null, issues: dedupe(issues) };
  }
  const v = parsed as AiOutput;
  if (v.schema_version !== kind) return { ok: false, value: null, issues: [{ code: "WRONG_KIND", message: `expected ${kind}, got ${v.schema_version}` }] };

  if (v.schema_version === "triage-v1") {
    for (const s of v.skill_candidates) if (!(check as TriageCheck).allowedSkillIds.has(s)) bad("UNKNOWN_SKILL", `skill ${s} is not in the taxonomy`);
    if (v.reason === "no_issue" && v.needs_deep_review) bad("INCONSISTENT", "reason no_issue contradicts needs_deep_review=true");
    return issues.length ? { ok: false, value: null, issues } : { ok: true, value: v, issues: [] };
  }

  const c = check as AnalysisCheck;
  if (v.attempt_id !== c.attemptId) bad("WRONG_ATTEMPT", "attempt_id does not match the analysed attempt");
  const len = codePointLength(c.submittedText);
  v.findings.forEach((f, i) => {
    if (!c.allowedSkillIds.has(f.skill_id)) bad("UNKNOWN_SKILL", `findings[${i}] names unknown skill ${f.skill_id}`);
    if (!(f.start < f.end)) bad("SPAN", `findings[${i}] span is empty or reversed`);
    if (f.end > len) bad("SPAN", `findings[${i}] span ends at ${f.end} but the text has ${len} characters`);
    if (!Number.isInteger(f.start) || !Number.isInteger(f.end)) bad("SPAN", `findings[${i}] offsets must be integers`);
  });
  const grammar = v.findings.filter((f) => f.kind === "grammar");
  if (v.judgement === "acceptable" && grammar.length > 0) bad("INCONSISTENT", "judgement acceptable contradicts grammar findings");
  if (v.judgement === "incorrect_candidate" && grammar.length === 0) bad("INCONSISTENT", "judgement incorrect_candidate needs at least one grammar finding");
  if ((v.judgement === "ambiguous" || v.judgement === "abstain") && grammar.length > 0) bad("INCONSISTENT", "ambiguous/abstain cannot assert a grammar violation; use incorrect_candidate only if substantiated, otherwise remove the grammar claim");
  if (v.schema_version === "analysis-v2") {
    const reasons = { acceptable: ["grammatical", "dialect_or_style"], incorrect_candidate: ["grammar_violation"], ambiguous: ["context_required"], abstain: ["incomplete_input", "insufficient_evidence"] };
    if (!reasons[v.judgement].includes(v.reason_code)) bad("INCONSISTENT", "reason_code contradicts judgement");
    if (v.judgement === "ambiguous" && !v.missing_context?.trim()) bad("INCONSISTENT", "ambiguous requires a specific missing_context fact");
    if ((v.judgement === "acceptable" || v.judgement === "incorrect_candidate") && v.missing_context !== null) bad("INCONSISTENT", "acceptable/incorrect_candidate requires missing_context=null");
    const chars = Array.from(c.submittedText);
    v.findings.forEach((f, i) => {
      if (chars.slice(f.start, f.end).join("") !== f.original) {
        const at = c.submittedText.indexOf(f.original);
        const unique = at >= 0 && c.submittedText.indexOf(f.original, at + 1) < 0;
        const offset = unique ? Array.from(c.submittedText.slice(0, at)).length : null;
        bad("SPAN_QUOTE", `findings[${i}].original must equal the exact submitted_text span` + (offset === null ? "" : `; this quote occurs at start=${offset}, end=${offset + Array.from(f.original).length}`));
      }
      if (f.kind === "grammar" && f.suggestion === f.original) bad("INCONSISTENT", "a grammar correction must change the quoted fragment");
    });
  }
  return issues.length ? { ok: false, value: null, issues } : { ok: true, value: v, issues: [] };
}

/** JSON syntax + schema only, deliberately separate from semantic/offset validity. */
export function isSchemaValidOutput(rawText: string, kind: "analysis-v1" | "analysis-v2" | "triage-v1"): boolean {
  if (Buffer.byteLength(rawText, "utf8") > MAX_OUTPUT_BYTES) return false;
  try {
    const parsed = JSON.parse(rawText);
    return parsed?.schema_version === kind && !!schemaValidator()(parsed);
  } catch { return false; }
}

const dedupe = (list: ValidationIssue[]): ValidationIssue[] => {
  const seen = new Set<string>();
  return list.filter((i) => (seen.has(`${i.code}|${i.message}`) ? false : (seen.add(`${i.code}|${i.message}`), true)));
};
