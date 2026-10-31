import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CEFR_RANGE, DEFAULT_SETTINGS_V1, SettingsV1Schema } from "@english-lab/contracts";
import type { Db } from "../db/open.js";
import { ApiError } from "../errors.js";
import { loadSettings } from "../domain/sessions/policy.js";

/** Only the keys the session allocator reads today; the other settings-v1 keys are kept as they are (docs/04 §7, D08). */
const SettingsPatchSchema = z
  .object({
    taskCount: z.number().int().min(5).max(30).optional(),
    weakRatio: z.number().min(0).max(1).optional(),
    voiceTarget: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    voiceShare: z.number().min(0).max(1).optional(),
    vocabularyTaskCount: z.number().int().min(5).max(10).optional(),
    vocabularyNewWordsPerSession: z.number().int().min(1).max(10).optional(),
    difficultyMin: z.enum(CEFR_RANGE).optional(),
    difficultyMax: z.enum(CEFR_RANGE).optional(),
  })
  .strict();

/**
 * Settings (docs/04 §7): every change appends a new settings revision; sessions keep the revision they were built with, so a change
 * never rewrites an existing session or its history. It applies to the next session that is started.
 */
export function registerSettingsRoutes(app: FastifyInstance, db: Db, deps: { now: () => Date; newId?: () => string }): void {
  const view = () => {
    const s = loadSettings(db);
    return { revision: s.revision, values: s.values, defaults: DEFAULT_SETTINGS_V1 };
  };

  app.get("/api/v1/settings", async () => view());

  app.post("/api/v1/settings", async (req) => {
    const patch = SettingsPatchSchema.safeParse(req.body);
    if (!patch.success) throw new ApiError(400, "VALIDATION_ERROR", "Settings are invalid", patch.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    db.transaction(() => {
      const cur = loadSettings(db);
      const next = SettingsV1Schema.parse({ ...cur.values, ...patch.data });
      if (JSON.stringify(next) === JSON.stringify(cur.values)) return;
      db.prepare("INSERT INTO settings_revisions(id, revision, values_json, created_at) VALUES (?,?,?,?)").run((deps.newId ?? randomUUID)(), cur.revision + 1, JSON.stringify(next), deps.now().toISOString());
    }).immediate();
    return view();
  });
}
