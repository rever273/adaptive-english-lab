import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, it } from "vitest";
import { openDatabase } from "../../../apps/server/src/db/open.js";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { conversationState, nextLessonTopic, startConversation, submitConversation } from "../../../apps/server/src/domain/conversation/repository.js";
import { runConversation, type ConversationPayload } from "../../../apps/server/src/domain/conversation/runner.js";
import { LESSON_START, LESSON_SWITCH } from "../../../apps/server/src/domain/conversation/lessonPrompt.js";
import type { ChatMessage } from "../../../apps/server/src/domain/ai/clients.js";
import type { RunnerContext } from "../../../apps/server/src/queue/types.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

it("a lesson works through its targets one at a time, switches on request and rotates targets between lessons", async () => {
  const scratch = makeScratchRoot();
  const db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  try {
    await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
    let clock = Date.parse("2026-11-12T10:00:00Z");
    const deps = { now: () => new Date((clock += 1000)), newId: randomUUID };
    db.prepare("INSERT INTO vocabulary_entries(id,lemma,pos,language,learned,user_revision,surface_forms_json,created_at) VALUES (?,?,?,?,0,0,'[]',?)").run(randomUUID(), "reckon", "verb", "en", "2026-11-01T00:00:00Z");
    db.prepare("INSERT INTO vocabulary_expressions(id,phrase,phrase_key,created_at) VALUES (?,?,?,?)").run(randomUUID(), "in the long run", "in the long run", "2026-11-01T00:00:00Z");

    const id = startConversation(db, deps, "", "tab", "lesson");
    const state = conversationState(db, id);
    expect(state.session).toMatchObject({ mode: "lesson" });
    const targets = state.lesson!.targets;
    expect(targets.map((t) => t.kind).sort()).toEqual(["expression", "grammar", "word"]);
    expect(targets.map((t) => t.status)).toEqual(["current", "queued", "queued"]);

    const calls: ChatMessage[][] = [];
    const chat = { chat: async (r: { messages: ChatMessage[] }) => { calls.push(r.messages); return { text: r.messages[0]!.content.includes("cautious") ? '{"level":"ok","ok":true,"feedback":"","corrected":"","grammar_skill_id":"","original":""}' : "Today we're having a crack at it.\n\nRU: Сегодня мы разбираем тему.\n\nYour turn: tell me one thing.", stats: { totalMs: 0, loadMs: null, promptTokens: null, evalTokens: null, evalMs: null } }; } };
    const run = async (action: "reply" | "analysis", messageId: string | null) => {
      const payload: ConversationPayload = { conversation: true, sessionId: id, action, messageId };
      const out = await runConversation(db, chat, { job: { payload }, signal: new AbortController().signal, checkpoint: () => undefined } as unknown as RunnerContext<ConversationPayload>);
      out.alsoCommit?.(db);
    };
    const system = (i: number) => calls[i]![0]!.content;

    await run("reply", null); // the opening: the introduction of the first target
    expect(system(0)).toContain("You are Sam");
    expect(system(0)).toContain(JSON.stringify(targets[0]!.label));
    expect(system(0)).toContain('"phase":"intro"');
    expect(calls[0]!.at(-1)).toEqual({ role: "user", content: LESSON_START });

    const answer = randomUUID();
    submitConversation(db, deps, id, "tab", answer, "I reckon it will rain.");
    expect(() => nextLessonTopic(db, deps, id, "tab")).toThrow(/wait/i); // no switch while the teacher has not replied
    await run("reply", answer);
    expect(system(1)).toContain('"learner_answers_on_this_target":1');
    expect(system(1)).toContain('"phase":"practice"');

    const doneJobs = () => { for (const st of ["running", "completed"]) db.prepare("UPDATE jobs SET state=? WHERE idempotency_key LIKE ? AND state NOT IN ('completed','failed','cancelled')").run(st, `conversation:${id}:topic:%`); };
    doneJobs(); // the queue would have finished the replies the test ran by hand
    nextLessonTopic(db, deps, id, "tab");
    expect(conversationState(db, id).lesson!.targets.map((t) => t.status)).toEqual(["done", "current", "queued"]);
    // while the switch reply is being written: no second switch (it would skip a target) and no answer to the old question
    expect(() => nextLessonTopic(db, deps, id, "tab")).toThrow(/wait/i);
    expect(() => submitConversation(db, deps, id, "tab", randomUUID(), "Late answer")).toThrow(/wait/i);
    expect(db.prepare("SELECT count(*) AS n FROM jobs WHERE idempotency_key=?").get(`conversation:${id}:topic:1`)).toEqual({ n: 1 });
    await run("reply", null);
    doneJobs();
    expect(calls[2]!.at(-1)).toEqual({ role: "user", content: LESSON_SWITCH });
    expect(system(2)).toContain('"just_switched_from_previous_target":true');
    expect(system(2)).toContain('"learner_answers_on_this_target":0');

    nextLessonTopic(db, deps, id, "tab");
    await run("reply", null);
    doneJobs();
    nextLessonTopic(db, deps, id, "tab"); // past the plan: one more target is added (another grammar rule, never one already in the lesson)
    const more = conversationState(db, id).lesson!.targets;
    expect(more).toHaveLength(4);
    expect(new Set(more.map((t) => t.label)).size).toBe(4);
    expect(more.at(-1)!.status).toBe("current");

    // the next lesson does not reuse the grammar rules of the first one while other rules are left
    const used = new Set(more.filter((t) => t.kind === "grammar").map((t) => t.label));
    const second = startConversation(db, deps, "", "tab2", "lesson");
    const grammar = conversationState(db, second).lesson!.targets.find((t) => t.kind === "grammar")!;
    expect(used.has(grammar.label)).toBe(false);

    // practice only: no attempts, no error events, no word events
    expect((db.prepare("SELECT count(*) AS n FROM attempts").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT count(*) AS n FROM error_events").get() as { n: number }).n).toBe(0);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally { db.close(); scratch.cleanup(); }
});
