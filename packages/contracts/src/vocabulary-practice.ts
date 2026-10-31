import { z } from "zod";

/**
 * Reviewable vocabulary metadata. This contract alone does not publish content:
 * it must be included in the revision's reviewed content hash before use.
 */
const Text = z.string().trim().min(1).max(500);
const Id = z.string().trim().min(1).max(128);

/**
 * entryId is a STABLE lexical key written in the content (e.g. "endeavour"), not a database id: published packs are shared, dictionaries
 * are personal. The learner's entry is found by `lemma` at selection time; senseId and partOfSpeech keep a noun and a verb apart.
 */
export const VocabularyTargetSchema = z.object({
  entryId: Id,
  lemma: Text,
  senseId: Id,
  partOfSpeech: Text,
  surfaceForm: Text,
}).strict();

/** optional Russian for the feedback: the whole sentence and the word as it stands in it (so the page can colour it) */
const Translation = { sentenceRu: Text.optional(), wordRu: Text.optional() };
const OptionSchema = z.object({ id: Id, text: Text, rationaleRu: Text }).strict();

export const VocabularyPracticeMetadataSchema = z.discriminatedUnion("family", [
  z.object({
    schemaVersion: z.literal("vocabulary-practice-v1"),
    family: z.literal("recognition"),
    target: VocabularyTargetSchema,
    options: z.array(OptionSchema).min(3).max(4),
    acceptedOptionId: Id,
    ...Translation,
  }).strict(),
  z.object({
    schemaVersion: z.literal("vocabulary-practice-v1"),
    family: z.literal("guided_recall"),
    target: VocabularyTargetSchema,
    guidedCue: Text,
    expectedWords: z.number().int().min(1).max(5),
    acceptedAnswers: z.array(Text).min(1).max(20),
    ...Translation,
  }).strict(),
  z.object({
    schemaVersion: z.literal("vocabulary-practice-v1"),
    family: z.literal("collocation"),
    target: VocabularyTargetSchema,
    pattern: Text,
    options: z.array(OptionSchema).min(3).max(4),
    acceptedOptionId: Id,
    ...Translation,
  }).strict(),
]).superRefine((item, ctx) => {
  if (item.family === "guided_recall") {
    const normalised = item.acceptedAnswers.map(normaliseVocabularyAnswer);
    if (new Set(normalised).size !== normalised.length) {
      ctx.addIssue({ code: "custom", path: ["acceptedAnswers"], message: "Accepted answers must be distinct after normalisation" });
    }
    return;
  }
  const ids = item.options.map((option) => option.id);
  const texts = item.options.map((option) => normaliseVocabularyAnswer(option.text));
  if (new Set(ids).size !== ids.length || new Set(texts).size !== texts.length) {
    ctx.addIssue({ code: "custom", path: ["options"], message: "Option IDs and text must be distinct" });
  }
  if (!ids.includes(item.acceptedOptionId)) {
    ctx.addIssue({ code: "custom", path: ["acceptedOptionId"], message: "Accepted option must exist" });
  }
});

/** Only normalises presentation; it never changes inflection or accepts substrings. */
export function normaliseVocabularyAnswer(value: string): string {
  return value.normalize("NFKC").replace(/[‘’]/g, "'").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

export type VocabularyPracticeMetadata = z.infer<typeof VocabularyPracticeMetadataSchema>;
