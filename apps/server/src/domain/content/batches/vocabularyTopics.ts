import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** the few general settings that were used before the shared topic list existed; kept as a fallback and as part of the pool */
const GENERAL_TOPICS = ["workplace", "travel", "health", "shopping", "family", "education", "community", "household", "sport", "food", "finance", "weather"] as const;
const STRIDES = [37, 41, 43, 47, 53] as const;

let cached: readonly string[] | null = null;

/** General settings plus every Audio Dictation topic (content/dictation/topics.json): a wide pool so sentences for one word differ in scene, not only in wording. */
export function vocabularyTopicPool(): readonly string[] {
  if (cached) return cached;
  const names: string[] = [...GENERAL_TOPICS];
  try {
    const file = fileURLToPath(new URL("../../../../../../content/dictation/topics.json", import.meta.url));
    const t = JSON.parse(readFileSync(file, "utf8")) as { topics?: Array<string | { name?: string }> };
    for (const x of t.topics ?? []) {
      const name = (typeof x === "string" ? x : x.name)?.trim();
      if (name && !names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name);
    }
  } catch {
    // the fallback list alone still works
  }
  cached = names;
  return cached;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** deterministic: the same ordinal and round always give the same topic, and nearby ordinals land on far-apart topics */
export function pickVocabularyTopic(ordinal: number, round: number): string {
  const pool = vocabularyTopicPool();
  const stride = STRIDES.find((s) => gcd(s, pool.length) === 1) ?? 1;
  return pool[(ordinal * stride + round * 11) % pool.length]!;
}
