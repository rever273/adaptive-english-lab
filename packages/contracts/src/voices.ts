import { z } from "zod";

/** TASK_029 (D122-D128): the Piper voice catalogue seen from the page. The weights are computed on the server and only displayed here. */
export const VOICE_PURPOSES = ["dictation", "books", "listening"] as const;
export const VoicePurposeSchema = z.enum(VOICE_PURPOSES);
export type VoicePurpose = z.infer<typeof VoicePurposeSchema>;
export const VoiceAgeGroupSchema = z.enum(["adult", "mature", "elderly"]);

export const VoiceSettingsUpdateSchema = z
  .object({
    enabled: z.boolean(),
    priorWeight: z.number().min(0).max(2),
    lengthScale: z.number().min(0.7).max(1.8),
    noiseScale: z.number().min(0).max(2).nullable(),
    noiseWScale: z.number().min(0).max(2).nullable(),
    maxSpeedUp: z.number().min(0).max(0.3),
    ageGroup: VoiceAgeGroupSchema,
    avoidGroups: z.array(z.string().min(1).max(40)).max(20),
    purposes: z.array(VoicePurposeSchema).max(3),
    impression: z.string().max(300).nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "nothing to change" });
export type VoiceSettingsUpdate = z.infer<typeof VoiceSettingsUpdateSchema>;

export const VoiceInfoSchema = z
  .object({
    key: z.string(),
    name: z.string(),
    gender: z.enum(["male", "female"]),
    ageGroup: VoiceAgeGroupSchema,
    impression: z.string().nullable(),
    enabled: z.boolean(),
    purposes: z.array(VoicePurposeSchema),
    avoidGroups: z.array(z.string()),
    lengthScale: z.number(),
    noiseScale: z.number().nullable(),
    noiseWScale: z.number().nullable(),
    maxSpeedUp: z.number(),
    revision: z.number().int(),
    source: z.enum(["seed", "user", "evaluation"]),
    checks: z.number().int(),
    heardRate: z.number().nullable(),
    flags: z.number().int(),
    weight: z.object({ prior: z.number(), offline: z.number(), live: z.number(), flags: z.number(), effective: z.number(), version: z.number().int() }).strict(),
    share: z.number(),
  })
  .strict();
export const VoicesResponseSchema = z.object({ purpose: VoicePurposeSchema, voices: z.array(VoiceInfoSchema) }).strict();
export type VoiceInfo = z.infer<typeof VoiceInfoSchema>;
export type VoicesResponse = z.infer<typeof VoicesResponseSchema>;

export const SoundFlagRequestSchema = z.object({ flagged: z.boolean() }).strict();
export const SoundFlagResponseSchema = z.object({ flagged: z.boolean() }).strict();
