import { createHash } from "node:crypto";
import { alignWords, mergeContractions, rawTokens, sameWord, tokenize, type DiffOp } from "@english-lab/contracts";

export { alignWords, mergeContractions, rawTokens, sameWord, tokenize, type DiffOp };

export const wordDistance = (expected: readonly string[], typed: readonly string[]): number => alignWords(expected, typed).distance;

export const isCorrect = (expected: string, typed: string): boolean => wordDistance(tokenize(expected), tokenize(typed)) === 0;

/** no-repeat key: sha256 of the normalised tokens (punctuation, case and apostrophes do not make a new sentence) */
export const dictationFingerprint = (text: string): string => createHash("sha256").update(tokenize(text).join(" "), "utf8").digest("hex");

/** Dictation Accuracy of one answer: 1 - word errors / expected words, never below 0 */
export const dictationAccuracy = (wordErrors: number, wordCount: number): number => Math.max(0, 1 - wordErrors / wordCount);
