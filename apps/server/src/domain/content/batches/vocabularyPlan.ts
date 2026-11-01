import type { Db } from "../../../db/open.js";
import { exportVocabulary, vocabularyCandidates } from "../../vocabulary/practice.js";
import type { Family } from "../../vocabulary/schedule.js";

const ORDER: readonly Family[] = ["recognition", "guided_recall", "recognition", "collocation", "guided_recall"];
const TARGET: Record<Family, number> = { recognition: 2, guided_recall: 2, collocation: 1 };
type Word = { lemma: string; translationRu: string | null; learned: boolean; newExercises: number };

/** Approved fresh and previously shown contexts can supply the five-context target; drafts cannot. */
export function vocabularyReplenishment(db: Db) {
  const words = (exportVocabulary(db).json as { words: Word[] }).words;
  const candidates = vocabularyCandidates(db);
  const counts = new Map<string, Record<Family, number>>();
  for (const c of [...candidates.usable, ...candidates.shown]) {
    const n = counts.get(c.lemma) ?? { recognition: 0, guided_recall: 0, collocation: 0 };
    n[c.family]++; counts.set(c.lemma, n);
  }
  const needs = words.map(word => {
    const have = counts.get(word.lemma) ?? { recognition: 0, guided_recall: 0, collocation: 0 };
    const deficit = Object.fromEntries(ORDER.filter((v, i) => ORDER.indexOf(v) === i).map(f => [f, Math.max(0, TARGET[f] - have[f])])) as Record<Family, number>;
    return { word, deficit };
  }).sort((a, b) => Number(a.word.learned) - Number(b.word.learned) || b.deficit.recognition + b.deficit.guided_recall + b.deficit.collocation - a.deficit.recognition - a.deficit.guided_recall - a.deficit.collocation || a.word.lemma.localeCompare(b.word.lemma));
  const deficit = needs.reduce((s, n) => s + n.deficit.recognition + n.deficit.guided_recall + n.deficit.collocation, 0);
  return { words: needs, deficit, recommended: Math.ceil(deficit * 1.2), targetPerWord: 5 };
}

/** Round-robin over deficit slots; requested extras are varied across words and formats. */
export function vocabularyPlanSlots(plan: ReturnType<typeof vocabularyReplenishment>, count: number) {
  const remaining = plan.words.map(n => ({ word: n.word, deficit: { ...n.deficit } }));
  const out: Array<{ word: Word; family: Family }> = [];
  while (out.length < count) {
    let added = false;
    for (const n of remaining) {
      const family = ORDER.find(f => n.deficit[f] > 0);
      if (family && out.length < count) { out.push({ word: n.word, family }); n.deficit[family]--; added = true; }
    }
    if (!added) break;
  }
  for (let i = 0; out.length < count && remaining.length; i++) out.push({ word: remaining[i % remaining.length]!.word, family: ORDER[Math.floor(i / remaining.length) % ORDER.length]! });
  return out;
}
