import { createEmptyCard, fsrs, generatorParameters, Rating, type Card } from "ts-fsrs";
import type { Db } from "../../db/open.js";
import { learningDate } from "../journey/calendar.js";
import { addDays, type WordSummary } from "./state.js";

/**
 * D168: FSRS (ts-fsrs) only ever sees the results of cloze checks. The card is not stored: it is replayed from the raw `vocab_typing_reviews` of the
 * word, in order, with a deterministic scheduler (no fuzz, no short-term steps). Self-assessments and typing are never ratings.
 */
export const FSRS_VERSION = "vt-fsrs-v1";

export interface RatedReview {
  rating: "good" | "again";
  at: string;
}

const scheduler = (retention: number) => fsrs(generatorParameters({ enable_fuzz: false, enable_short_term: false, request_retention: retention }));

/** the card after every rated check of the word; null before the first one */
export function replayCard(reviews: readonly RatedReview[], retention: number): Card | null {
  if (reviews.length === 0) return null;
  const f = scheduler(retention);
  let card = createEmptyCard(new Date(reviews[0]!.at));
  for (const r of reviews) card = f.next(card, new Date(r.at), r.rating === "good" ? Rating.Good : Rating.Again).card;
  return card;
}

export function loadReviews(db: Db): Map<string, RatedReview[]> {
  const out = new Map<string, RatedReview[]>();
  for (const r of db.prepare("SELECT lemma, rating, created_at AS at FROM vocab_typing_reviews WHERE rating IS NOT NULL ORDER BY created_at, card_index").all() as Array<{ lemma: string; rating: "good" | "again"; at: string }>) {
    const list = out.get(r.lemma) ?? [];
    list.push({ rating: r.rating, at: r.at });
    out.set(r.lemma, list);
  }
  return out;
}

/**
 * The learning day on which the next check of a word is due: an unconfirmed "Learned" is checked `firstCheckDays` learning days after it was
 * pressed (also after a failed check), a verified word when its FSRS card says so. Other states have no check.
 */
export function dueDate(s: WordSummary, reviews: readonly RatedReview[], retention: number, firstCheckDays: number): string | null {
  if (s.state === "awaiting_verification" && s.lastLearnedDate) return addDays(s.lastLearnedDate, firstCheckDays);
  if (s.state === "verified") {
    const card = replayCard(reviews, retention);
    return card ? learningDate(card.due.getTime()) : null;
  }
  return null;
}

