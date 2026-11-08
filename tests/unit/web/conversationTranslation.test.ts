import { beforeEach, expect, it, vi } from "vitest";

const translateSentence = vi.hoisted(() => vi.fn<(text: string) => Promise<{ text: string }>>());
vi.mock("../../../apps/web/src/api", () => ({ translateSentence }));
import { translateConversationMessage } from "../../../apps/web/src/conversationTranslation";

beforeEach(() => { translateSentence.mockReset(); translateSentence.mockImplementation(async text => ({ text })); });

it("translates a long assistant message in full using provider-sized chunks", async () => {
  const text = `${"word ".repeat(110)}ending`;
  expect(await translateConversationMessage(text)).toBe(text);
  expect(translateSentence.mock.calls.length).toBeGreaterThan(1);
  expect(translateSentence.mock.calls.every(([chunk]) => chunk.length <= 450)).toBe(true);
});

it("does not split surrogate pairs and propagates provider errors", async () => {
  const text = `${"a".repeat(449)}😀end`;
  expect(await translateConversationMessage(text)).toBe(`${"a".repeat(449)} 😀end`);
  expect(translateSentence.mock.calls[0]![0]).toBe("a".repeat(449));
  translateSentence.mockRejectedValueOnce(new Error("unavailable"));
  await expect(translateConversationMessage("Hello")).rejects.toThrow("unavailable");
});
