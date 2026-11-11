import { createHash } from "node:crypto";
import type { RawRow, Rejection } from "./source.js";

/**
 * Deterministic cleaning of gap-fill rows (TASK_032 stage 1, cloze-clean-v1). Pure functions, no I/O.
 * Never changes the meaning or grammatical form of a solution or distractor; only whitespace, invisible characters and exact duplicates.
 */
export interface CleanConfig {
  version: string;
  minWords: number;
  maxWords: number;
  maxOptionWords: number;
  maxOptionChars: number;
  noFinalPunctuationFlagShare: number;
}
export interface CleanItem {
  sourceIndex: number;
  gappedText: string;
  solution: string;
  distractors: string[];
  filledText: string;
  sourceTopic: string;
  contentHash: string;
  fixes: string[];
  flagReasons: string[];
}

const ZERO_WIDTH = /[​-‍⁠﻿]/g;
const SPACES = /[   -   　\t\r\n\f\v]+/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const MOJIBAKE = /(â€|Ã.|Â|вЂ|Ð.)/;
const MARKUP = /<[^>]+>|&[a-z]+;|&#\d+;|https?:\/\/|www\.|\S+@\S+\.\S+/i;
const PHONE = /\+?\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}/;
const EMPTY_TURN = /(^|\s)-\s*$|(^|\s)-\s+-(\s|$)/;
const FINAL_PUNCT = /[.!?"')’”]$/;

const collapse = (s: string): string => s.replace(SPACES, " ").replace(/ {2,}/g, " ").trim();
/** space before , . ! ? ; : is removed (a safe fix) */
const tightPunct = (s: string): string => s.replace(/ +([,.!?;:])/g, "$1");
export const wordCount = (s: string): number => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
export const lc = (s: string): string => s.toLowerCase();
/** comparison key for sentence consistency: typographic quotes unified */
const unify = (s: string): string => s.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');

export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
export function hashContent(r: { gappedText: string; solution: string; distractors: string[]; filledText: string; sourceTopic: string }): string {
  return sha256(JSON.stringify([r.gappedText, r.solution, [...r.distractors].sort(), r.filledText, r.sourceTopic]));
}

export type CleanOutcome = { ok: true; item: CleanItem } | { ok: false; reject: Rejection };

/** the text before the gap, without a leading dialogue dash */
export function startsSentence(before: string): boolean {
  const b = before.replace(/^(\s*-\s*)+/, "").trim();
  if (b === "") return true;
  return /[.!?:]["')”]?$/.test(b) || /(^|\s)-\s*$/.test(before.trim());
}

export function cleanRow(row: RawRow, cfg: CleanConfig): CleanOutcome {
  const rej = (reason: string, detail?: string): CleanOutcome => ({ ok: false, reject: { sourceIndex: row.sourceIndex, reason, detail } });
  const fixes: string[] = [];
  const flagReasons: string[] = [];
  const raw = [row.gappedText, row.solution, row.filledText, row.sourceTopic, ...row.distractors];
  if (raw.some((s) => CONTROL.test(s.replace(SPACES, " ")))) return rej("control_chars");
  if (raw.some((s) => s.includes("�") || MOJIBAKE.test(s))) return rej("encoding");
  const norm = (s: string): string => collapse(s.normalize("NFC").replace(ZERO_WIDTH, ""));
  const nGap = norm(row.gappedText), nSol = norm(row.solution), nFilled = norm(row.filledText);
  if (nGap !== row.gappedText || nSol !== row.solution || nFilled !== row.filledText) fixes.push("whitespace_normalised");
  let gapped = tightPunct(nGap);
  let filled = tightPunct(nFilled);
  if (gapped !== nGap || filled !== nFilled) fixes.push("space_before_punctuation");
  // exactly one gap
  const gaps = gapped.match(/_{3,}/g) ?? [];
  if (gaps.length !== 1) return rej("gap_count", String(gaps.length));
  gapped = gapped.replace(/_{3,}/, "___");
  const solution = nSol;
  if (solution === "" || solution.includes("___")) return rej("solution_shape");
  // options: normalise, drop duplicates and any equal to the solution
  const seen = new Set<string>([lc(solution)]);
  const distractors: string[] = [];
  for (const o of row.distractors) {
    const t = norm(o);
    if (t === "") { fixes.push("empty_distractor_removed"); continue; }
    const k = lc(t);
    if (seen.has(k)) { fixes.push(k === lc(solution) ? "distractor_equals_solution" : "duplicate_distractor"); continue; }
    seen.add(k);
    distractors.push(t);
  }
  if (distractors.length < 1) return rej("too_few_options");
  if (distractors.length > 3) return rej("too_many_options");
  for (const o of [solution, ...distractors]) {
    if (o.includes("___") || /[.!?]$/.test(o)) return rej("option_shape");
    if (wordCount(o) > cfg.maxOptionWords || o.length > cfg.maxOptionChars) return rej("option_too_long");
  }
  // the filled sentence must be the gapped one with the solution put in
  const rebuilt = tightPunct(gapped.replace("___", solution));
  if (unify(rebuilt) !== unify(filled)) {
    if (unify(rebuilt).replace(/ /g, "") === unify(filled).replace(/ /g, "")) { fixes.push("filled_rebuilt"); filled = rebuilt; } else return rej("filled_mismatch");
  } else if (rebuilt !== filled) { fixes.push("filled_rebuilt"); filled = rebuilt; }
  // junk
  const all = [gapped, filled, solution, ...distractors, row.sourceTopic];
  if (all.some((s) => MARKUP.test(s) || PHONE.test(s))) return rej("markup_or_contact");
  if (EMPTY_TURN.test(gapped)) return rej("empty_dialogue_turn");
  const words = wordCount(filled);
  if (words < cfg.minWords) return rej("too_short", String(words));
  if (words > cfg.maxWords) return rej("too_long", String(words));
  // flags (the item stays, but outside the active set)
  const before = gapped.slice(0, gapped.indexOf("___"));
  const start = startsSentence(before);
  const upper = /^\p{Lu}/u.test(solution);
  if (start && !upper && /^\p{L}/u.test(solution)) flagReasons.push("case_position");
  else if (!start && upper && !/^I(\b|')/.test(solution) && distractors.some((o) => /^\p{Ll}/u.test(o))) flagReasons.push("case_position");
  const item: CleanItem = { sourceIndex: row.sourceIndex, gappedText: gapped, solution, distractors, filledText: filled, sourceTopic: row.sourceTopic, contentHash: "", fixes, flagReasons };
  item.contentHash = hashContent(item);
  return { ok: true, item };
}

export interface CleanReport {
  total: number;
  kept: number;
  rejected: Record<string, number>;
  fixes: Record<string, number>;
  flagged: Record<string, number>;
  noFinalPunctuation: { count: number; flagged: boolean };
  sweep: { minWords: Record<string, number>; maxWords: Record<string, number> };
}

const bump = (m: Record<string, number>, k: string, n = 1): void => { m[k] = (m[k] ?? 0) + n; };
export const sentenceKey = (s: string): string => lc(unify(s)).replace(/\s+/g, " ").trim();

/** cleans all rows, then removes exact duplicates and flags conflicting answer keys */
export function cleanAll(rows: RawRow[], cfg: CleanConfig, earlier: Rejection[] = []): { items: CleanItem[]; rejected: Rejection[]; report: CleanReport } {
  const rejected: Rejection[] = [...earlier];
  const kept: CleanItem[] = [];
  const report: CleanReport = { total: rows.length + earlier.length, kept: 0, rejected: {}, fixes: {}, flagged: {}, noFinalPunctuation: { count: 0, flagged: false }, sweep: { minWords: {}, maxWords: {} } };
  const wide = { ...cfg, minWords: 0, maxWords: 1e9 };
  for (const r of rows) {
    const o = cleanRow(r, cfg);
    if (o.ok) { kept.push(o.item); continue; }
    rejected.push(o.reject);
  }
  // how much each sentence-length threshold would cut, measured on rows that pass everything else
  for (const r of rows) {
    const o = cleanRow(r, wide);
    if (!o.ok) continue;
    const w = wordCount(o.item.filledText);
    for (const n of [3, 4, 5, 6, 7]) if (w < n) bump(report.sweep.minWords, `<${n}`);
    for (const n of [30, 40, 50, 60, 80]) if (w > n) bump(report.sweep.maxWords, `>${n}`);
  }
  // exact duplicates: keep the smallest source index
  const byKey = new Map<string, CleanItem>();
  const unique: CleanItem[] = [];
  for (const it of kept.sort((a, b) => a.sourceIndex - b.sourceIndex)) {
    const key = [sentenceKey(it.gappedText), lc(it.solution), [...it.distractors].map(lc).sort().join("|")].join("##");
    if (byKey.has(key)) { rejected.push({ sourceIndex: it.sourceIndex, reason: "duplicate", detail: String(byKey.get(key)!.sourceIndex) }); continue; }
    byKey.set(key, it);
    unique.push(it);
  }
  // same sentence, different keys: ambiguity risk for all of them
  const bySentence = new Map<string, CleanItem[]>();
  for (const it of unique) { const k = sentenceKey(it.gappedText); (bySentence.get(k) ?? bySentence.set(k, []).get(k)!).push(it); }
  for (const group of bySentence.values()) if (group.length > 1) for (const it of group) it.flagReasons.push("conflicting_keys");
  // missing final punctuation is a style of the source when common; a flag only when rare
  const noPunct = unique.filter((it) => !FINAL_PUNCT.test(it.filledText));
  report.noFinalPunctuation = { count: noPunct.length, flagged: noPunct.length / Math.max(1, unique.length) < cfg.noFinalPunctuationFlagShare };
  if (report.noFinalPunctuation.flagged) for (const it of noPunct) it.flagReasons.push("no_final_punctuation");
  for (const r of rejected) bump(report.rejected, r.reason);
  for (const it of unique) { for (const f of it.fixes) bump(report.fixes, f); for (const f of it.flagReasons) bump(report.flagged, f); }
  report.kept = unique.length;
  return { items: unique, rejected, report };
}
