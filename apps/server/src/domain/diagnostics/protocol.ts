/**
 * Pinned protocols (spec/04 "Стартовая диагностика", D53). A protocol id is part of the cohort of every attempt made under it, so evidence from
 * different protocols is never mixed and a changed protocol needs a new id.
 */
export const DIAGNOSTIC_PROTOCOL = {
  id: "diagnostic-v1",
  bankRole: "diagnostic",
  blocks: 3,
  blockSize: 8,
  perBlock: { recognition: 3, correction: 3, production: 2 },
  minNoMistakePerBlock: 1,
  distinctSkillsPerBlock: true,
  /** voice is never part of the starting baseline (spec/04: "voice 0-1 replaced by text"): every slot is typed */
  voiceSlots: 0,
  /** formats a block draws from; reading passages stay in practice (their children are a different cohort) */
  formats: { recognition: ["choose_form", "choose_missing_fragment"], correction: ["detect_error"], production: ["guided_short_answer", "russian_to_english_short"] },
  /** broad coverage first (spec/04): these families lead, the rest follow */
  familyOrder: ["articles", "verb_patterns", "agreement", "questions", "modals", "passive", "conditionals", "relatives"],
} as const;

export const HELDOUT_PROTOCOL = {
  id: "heldout-v1",
  bankRole: "heldout",
  /** up to this many tasks per check (same R/C/P mix as a diagnostic block where the bank allows) */
  maxSize: 8,
  minSize: 4,
  perCheck: { recognition: 3, correction: 3, production: 2 },
  /** a skill may be checked only once the learner has practised it for at least this long (delayed independent check) */
  minDelayDays: 7,
  /** a held-out sentence is consumed by one check; hints and shown answers are closed */
  singleUse: true,
} as const;

export type ProtocolId = typeof DIAGNOSTIC_PROTOCOL.id | typeof HELDOUT_PROTOCOL.id;
