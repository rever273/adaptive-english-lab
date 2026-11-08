import { translateSentence } from "./api";

/** The shared MyMemory endpoint truncates inputs above 450 characters. */
export async function translateConversationMessage(text: string): Promise<string> {
  let remaining = text.trim();
  const translated: string[] = [];
  while (remaining) {
    let end = remaining.length;
    if (end > 450) {
      const boundary = remaining.lastIndexOf(" ", 450);
      end = boundary > 0 ? boundary : 450;
      // Do not split a UTF-16 surrogate pair at the provider limit.
      if (end < remaining.length && /[\uD800-\uDBFF]/.test(remaining[end - 1]!)) end--;
    }
    translated.push((await translateSentence(remaining.slice(0, end))).text);
    remaining = remaining.slice(end).trimStart();
  }
  return translated.join(" ");
}
