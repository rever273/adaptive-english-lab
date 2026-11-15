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
    expect(targets.map((t) => t.status)).toEqual(["current"]); // one target per lesson
    expect(conversationState(db, id).lesson!.finished).toBe(false);

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

    // up to the eighth answer: practice, then the teacher's closing message ends the lesson (no task, no next topic)
    for (let n = 2; n <= 8; n++) {
      const m = randomUUID();
      submitConversation(db, deps, id, "tab", m, `Answer ${n}`);
      expect(conversationState(db, id).lesson!.finished).toBe(false);
      await run("reply", m);
    }
    expect(system(calls.length - 1)).toContain('"phase":"wrap_up"');
    expect(system(calls.length - 1)).toContain("do NOT suggest another topic");
    expect(conversationState(db, id).lesson!.finished).toBe(true);
    expect(() => nextLessonTopic(db, deps, id, "tab")).toThrow();

    // the next lesson takes another kind of target and does not reuse the grammar rule of the first one
    const firstKind = targets[0]!;
    const second = startConversation(db, deps, "", "tab2", "lesson");
    const next = conversationState(db, second).lesson!.targets;
    expect(next).toHaveLength(1);
    expect(next[0]!.kind).not.toBe(firstKind.kind);

    // practice only: no attempts, no error events, no word events
    expect((db.prepare("SELECT count(*) AS n FROM attempts").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT count(*) AS n FROM error_events").get() as { n: number }).n).toBe(0);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally { db.close(); scratch.cleanup(); }
});

it("a lesson on the learner's own topic asks what to practise, maps the answer onto skill cards and records the target", async () => {
  const scratch = makeScratchRoot();
  const db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  try {
    await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
    const deps = { now: () => new Date(), newId: randomUUID };
    const id = startConversation(db, deps, "", "tab", "lesson", true);
    expect(conversationState(db, id).lesson!.targets).toEqual([]);

    const answers: string[] = [];
    const calls: ChatMessage[][] = [];
    const chat = { chat: async (r: { messages: ChatMessage[] }) => { calls.push(r.messages); return { text: answers.shift() ?? "", stats: { totalMs: 0, loadMs: null, promptTokens: null, evalTokens: null, evalMs: null } }; } };
    const run = async (action: "reply" | "analysis", messageId: string | null) => {
      const payload: ConversationPayload = { conversation: true, sessionId: id, action, messageId };
      const out = await runConversation(db, chat, { job: { payload }, signal: new AbortController().signal, checkpoint: () => undefined } as unknown as RunnerContext<ConversationPayload>);
      out.alsoCommit?.(db);
    };
    const last = () => (db.prepare("SELECT text FROM conversation_messages WHERE session_id=? AND role='assistant' ORDER BY rowid DESC LIMIT 1").get(id) as { text: string }).text;
    const say = (text: string) => { const m = randomUUID(); submitConversation(db, deps, id, "tab", m, text); return m; };

    await run("reply", null); // the opening needs no model
    expect(calls).toHaveLength(0);
    expect(last()).toContain("What would you like to practise today?");

    const first = say("I want to improve my English.");
    answers.push(JSON.stringify({ ready: false, grammar_skill_ids: [], topic_label: "", reply: "Which grammar point gives you trouble?" }));
    await run("reply", first);
    expect(last()).toBe("Which grammar point gives you trouble?");
    expect(conversationState(db, id).lesson!.targets).toEqual([]); // still choosing

    const second = say("I mix up Present Perfect and Past Simple.");
    answers.push(JSON.stringify({ ready: true, grammar_skill_ids: ["not.a.skill"], topic_label: "Present Perfect vs Past Simple", reply: "" }), "Right, the mix-up is common.\n\nYour turn: tell me what you did today.");
    await run("reply", second);
    const targets = conversationState(db, id).lesson!.targets;
    expect(targets).toEqual([{ ordinal: 0, kind: "grammar", label: "Present Perfect vs Past Simple", status: "current" }]);
    expect(last()).toContain("Your turn");
    const system = calls.at(-1)![0]!.content;
    expect(system).toContain("learner_request");
    expect(system).toContain("I mix up Present Perfect and Past Simple.");
    expect(db.prepare("SELECT target_key AS k FROM conversation_lesson_targets WHERE session_id=?").get(id)).toEqual({ k: "custom:present-perfect-vs-past-simple" });
    expect((db.prepare("SELECT count(*) AS n FROM attempts").get() as { n: number }).n).toBe(0);
  } finally { db.close(); scratch.cleanup(); }
});
