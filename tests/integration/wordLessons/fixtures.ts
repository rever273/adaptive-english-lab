import { randomUUID } from "node:crypto";
import path from "node:path";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import type { CallStats, ChatClient, ChatMessage } from "../../../apps/server/src/domain/ai/clients.js";
import { AI_CONFIG_V3 } from "../../../apps/server/src/domain/ai/config.js";
import { GenerationJobRunner } from "../../../apps/server/src/domain/content/batches/generationRunner.js";
import { AnalysisJobRunner } from "../../../apps/server/src/domain/ai/analysisRunner.js";
import { addWord, patchWord } from "../../../apps/server/src/domain/vocabulary/repository.js";
import { completeJob, failOrRetry, getJob, startRunning } from "../../../apps/server/src/queue/jobs.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

export const deps = { now: () => new Date(), newId: randomUUID };
const stats: CallStats = { totalMs: 1, loadMs: null, promptTokens: null, evalTokens: null, evalMs: null };

export interface Env {
  db: Db;
  cleanup: () => void;
}

export async function setup(): Promise<Env> {
  const scratch = makeScratchRoot();
  const db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
  return {
    db,
    cleanup: () => {
      db.close();
      scratch.cleanup();
    },
  };
}

/** a saved word with a translation (so a lesson can be made for it) */
export function saveWord(db: Db, word: string, translation = "не заметить, упустить из виду"): string {
  const a = addWord(db, deps, { word });
  patchWord(db, deps, a.entry.id, { expectedRevision: a.entry.userRevision, translationRu: translation });
  return a.entry.id;
}

const RU = "Пример на русском языке";

/** what a good model answers for the word "overlook", by task */
export function goodAnswers(count = 3): Record<string, unknown> {
  return {
    stage12: {
      examples: [
        { en: "Please do not overlook the small print in this contract.", ru: RU },
        { en: "She overlooked a serious mistake in the first report.", ru: RU },
        { en: "It is easy to overlook how much effort the whole team put in.", ru: RU },
      ],
      gap: { full_en: "Nobody wanted to overlook the neighbours who had helped during the floods.", ru: RU, form: "overlook", also_accepted: [] },
    },
    stage3: {
      chained: false,
      items: [
        { source_en: "The inspector overlooked a crack in the wall.", construction_en: "Passive voice", instruction_en: "Rewrite the sentence in the passive voice.", expected_en: "A crack in the wall was overlooked by the inspector.", accepted_en: ["A crack in the wall was overlooked by the inspector."], hint_partial_en: "A crack in the wall", translation_ru: RU, used_skill: true },
        { source_en: "She overlooks small details when she is tired.", construction_en: "Passive voice", instruction_en: "Rewrite the sentence in the passive voice.", expected_en: "Small details are overlooked by her when she is tired.", accepted_en: ["Small details are overlooked by her when she is tired."], hint_partial_en: "Small details are overlooked", translation_ru: RU, used_skill: false },
        { source_en: "They overlooked the warning signs last year.", construction_en: "Passive voice", instruction_en: "Rewrite the sentence in the passive voice.", expected_en: "The warning signs were overlooked by them last year.", accepted_en: ["The warning signs were overlooked by them last year."], hint_partial_en: "The warning signs were", translation_ru: RU, used_skill: true },
      ].slice(0, count),
    },
    stage4: {
      cue_ru: RU,
      construction_en: "Third conditional",
      pattern: "If + Past Perfect, would have + V3",
      pattern_example_en: "If I had left earlier, I would have caught the train.",
      expected_en: "If I had not overlooked the deadline, I would have finished on time.",
      accepted_en: ["If I had not overlooked the deadline, I would have finished on time."],
      hint_partial_en: "If I had not overlooked the deadline,",
      translation_ru: RU,
      used_skill: true,
    },
    stage5: {
      situation_en: "Describe something you missed while rushing through a busy morning.",
      situation_ru: RU,
      suggested_words: ["deadline", "careless", "notice"],
      sample_en: "I overlooked the deadline because I was rushing through my morning.",
      sample_ru: RU,
      hint_start_en: "I overlooked the deadline because",
    },
  };
}

type Task = "stage12" | "stage3" | "stage4" | "stage5" | "review" | "pairs" | "uses" | "keep" | "check";

/** A scripted model: answers by the task written in the user message; `over` replaces a task's reply (a string is sent as it is). */
export function scriptedChat(over: Partial<Record<Task, () => unknown>> = {}): ChatClient & { calls: Array<{ task: string; messages: ChatMessage[] }> } {
  const calls: Array<{ task: string; messages: ChatMessage[] }> = [];
  return {
    calls,
    chat: async (req) => {
      const system = req.messages[0]!.content;
      const input = JSON.parse(req.messages[1]!.content) as Record<string, unknown>;
      const task: Task = system.includes("strict reviewer") ? "review" : system.includes("compare English sentences") ? "pairs" : system.includes("judge how a target English word") ? "uses" : system.includes("check sentence transformations") ? "keep" : system.includes("You check ONE sentence") ? "check" : (String(input.task) as Task);
      calls.push({ task, messages: req.messages });
      const base = goodAnswers(Number(input.count ?? 3));
      if (input.stage_requirements_override) {
        if (task === "stage3") {
          const stage = base.stage3 as { items: Array<{ construction_en: string; hint_partial_en: string; used_skill: boolean }> };
          const skills = input.skills as Array<{ construction: string }>;
          for (const [i, item] of stage.items.entries()) {
            item.construction_en = skills[i]!.construction;
            item.hint_partial_en = RU;
            item.used_skill = true;
          }
        } else if (task === "stage4") {
          Object.assign(base.stage4 as object, { construction_en: (input.skill as { construction: string }).construction, hint_partial_en: RU });
        } else if (task === "stage5") {
          Object.assign(base.stage5 as object, { situation_en: "Describe what you missed this morning.", hint_start_en: RU });
        }
      }
      const reply = over[task] ? over[task]!() : task === "review" ? { problems: [] } : task === "pairs" ? { pairs: [] } : task === "uses" ? { uses: [] } : task === "keep" ? { items: [] } : base[task];
      return { text: typeof reply === "string" ? reply : JSON.stringify(reply), stats };
    },
  };
}

export function generationRunner(db: Db, chat: ChatClient): GenerationJobRunner {
  return new GenerationJobRunner({ db, chat, installedDigest: async () => AI_CONFIG_V3.analysis.digest, runtimeVersion: async () => "test", deps, sleep: async () => {} });
}

export function analysisRunner(db: Db, chat: ChatClient): AnalysisJobRunner {
  return new AnalysisJobRunner({ db, chat, installedDigest: async () => AI_CONFIG_V3.analysis.digest, runtimeVersion: async () => "test", deps, sleep: async () => {} });
}

/** runs the oldest queued job whose payload has the given key through the real job lifecycle (start, run, commit the result or fail it) */
export async function runJob(db: Db, runner: { run: (ctx: never) => Promise<{ schemaVersion: string; output: unknown; metrics?: Record<string, unknown>; alsoCommit?: (db: Db) => void }> }, payloadKey: string): Promise<{ error: unknown | null }> {
  const row = db.prepare(`SELECT id FROM jobs WHERE json_extract(payload_json, '$.${payloadKey}') IS NOT NULL AND state = 'queued' ORDER BY created_at, rowid LIMIT 1`).get() as { id: string } | undefined;
  if (!row) throw new Error("no queued job");
  db.prepare("UPDATE gpu_lock SET fencing_token = 1 WHERE id = 1").run();
  startRunning(db, deps, row.id, 1);
  const job = getJob(db, row.id)!;
  try {
    const out = await runner.run({ job, token: 1, signal: new AbortController().signal, checkpoint: () => {} } as never);
    completeJob(db, deps, row.id, 1, out);
    return { error: null };
  } catch (e) {
    failOrRetry(db, deps, row.id, 1, { code: (e as { code?: string }).code ?? "runner_error", transient: false });
    return { error: e };
  }
}
