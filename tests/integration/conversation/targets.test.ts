import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, it } from "vitest";
import { openDatabase } from "../../../apps/server/src/db/open.js";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { startConversation, conversationState } from "../../../apps/server/src/domain/conversation/repository.js";
import { conversationTarget, conversationWord } from "../../../apps/server/src/domain/conversation/practiceTargets.js";
import type { WordEvent } from "../../../apps/server/src/domain/vocabulary/schedule.js";
import { runConversation, type ConversationPayload } from "../../../apps/server/src/domain/conversation/runner.js";
import type { RunnerContext } from "../../../apps/server/src/queue/types.js";
import type { ChatMessage } from "../../../apps/server/src/domain/ai/clients.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

it("prioritises due words, alternates with new ones, and avoids a recent mention", () => {
  const now = new Date("2026-11-08T00:00:00Z");
  const entries = [{ lemma: "stumble", learned: 0 }, { lemma: "curious", learned: 0 }, { lemma: "familiar", learned: 1 }];
  const events = new Map<string, WordEvent[]>([["stumble", [{ at: "2026-11-07T00:00:00Z", outcome: "miss", revisionId: "r", slotId: "s" }]]]);
  const select = (cycle: number, recent = "") => conversationWord(entries, events, { sessionId: "test", cycle, recent, now });
  expect(select(0)).toEqual({ kind: "word", value: "stumble" });
  expect(select(1)).toEqual({ kind: "word", value: "curious" });
  expect(select(2, "I sometimes stumble.")).toEqual({ kind: "word", value: "curious" });
  expect(select(3)).toEqual({ kind: "word", value: "familiar" });
  expect(events.get("stumble")).toHaveLength(1);
});

it("rotates visible words and expressions into real dialog prompts without writing learning evidence", async () => {
  const scratch = makeScratchRoot(), db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  try {
    await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
    const now = "2026-11-08T00:00:00.000Z";
    const insWord = db.prepare("INSERT INTO vocabulary_entries(id,lemma,pos,language,learned,surface_forms_json,created_at) VALUES (?,?,'adjective','en',0,'[]',?)");
    insWord.run("w1", "puzzled", now); insWord.run("w2", "hidden", now);
    db.prepare("INSERT INTO vocabulary_entry_events(id,entry_id,kind,created_at) VALUES ('we','w2','removed',?)").run(now);
    db.prepare("INSERT INTO vocabulary_expressions(id,phrase,phrase_key,created_at) VALUES ('e1','catch up','catch up',?),('e2','keep away','keep away',?)").run(now, now);
    db.prepare("INSERT INTO vocabulary_expression_events(id,expression_id,kind,created_at) VALUES ('ee','e2','removed',?)").run(now);
    const id = startConversation(db, { now: () => new Date(now), newId: randomUUID }, "Coffee", "tab");
    const target = (turn: number, recent = "") => conversationTarget(db, { sessionId: id, turn, recent, now: new Date(now) });
    expect(target(0)).toEqual({ kind: "word", value: "puzzled" });
    expect(target(1)).toEqual({ kind: "none", value: null }); // no confirmed grammar evidence in a fresh database
    expect(target(2)).toEqual({ kind: "expression", value: "catch up" });
    expect(target(3)).toEqual({ kind: "none", value: null });
    expect(target(2)).toEqual(target(2));
    const captured: ChatMessage[][] = [];
    const chat = { chat: async (r: { messages: ChatMessage[] }) => { captured.push(r.messages); return { text: "How are you?", stats: { totalMs: 0, loadMs: null, promptTokens: null, evalTokens: null, evalMs: null } }; } };
    const run = async (messageId: string | null) => {
      const payload: ConversationPayload = { conversation: true, sessionId: id, action: "reply", messageId };
      await runConversation(db, chat, { job: { payload }, signal: new AbortController().signal, checkpoint: () => undefined } as unknown as RunnerContext<ConversationPayload>);
    };
    await run(null);
    expect(captured[0]![0]!.content).toContain('"kind":"word","value":"puzzled"');
    const add = db.prepare("INSERT INTO conversation_messages(id,session_id,role,text,created_at) VALUES (?,?,?, ?,?)");
    add.run("u1", id, "user", "Hello", now); add.run("a1", id, "assistant", "How are you?", now); add.run("u2", id, "user", "Fine", now);
    await run("u2");
    expect(captured[1]![0]!.content).toContain('"kind":"expression","value":"catch up"');
    expect(captured[1]![0]!.content).not.toContain("keep away");
    expect(conversationState(db, id).vocabulary).toContain("catch up");
    expect(conversationState(db, id).vocabulary).not.toContain("keep away");
    expect(db.prepare("SELECT count(*) AS n FROM attempts").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM error_events").get()).toEqual({ n: 0 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally { db.close(); scratch.cleanup(); }
});
