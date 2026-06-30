import type { Message } from "../../contracts/conversation-message.type";

/**
 * Pull the text a content-inspection middleware should care about
 * from the outbound message list.
 *
 * **Role.** Built-ins that inspect "what the user just said" — the
 * guardrail on `trip.before`, the semantic cache on `trip.before`,
 * future consumers like PII redactors — all need the same string:
 * the most recent `user`-role message's text content. This helper
 * is the single authority on how that string is resolved.
 *
 * **Behavior.**
 * - Walks `messages` from the end backwards so the LAST user turn
 *   wins (correct when the agent has history + a fresh prompt).
 * - Returns a plain string directly when `content` is a string.
 * - Joins `text` parts with `"\n"` when `content` is a multipart
 *   `ContentPart[]`. Non-text parts (images, audio, pdf) are skipped —
 *   callers concerned with multimodal content inspect `request`
 *   / attachments separately.
 * - Returns `""` when there is no user message at all (e.g. a trip
 *   composed entirely of tool results).
 *
 * **Coverage limit (D3).** Because only `text` parts are extracted, any
 * guardrail / PII detector built on this helper inspects **text only** —
 * image / PDF / audio attachment content is NOT scanned. A guardrail is
 * therefore not a multimodal safety control: for non-text inputs add an
 * attachment-level policy (e.g. an OCR / moderation pass before the call)
 * rather than relying on input detectors.
 *
 * @example
 * const prompt = extractUserText(context.messages);
 * if (!prompt) return;
 * const verdict = await inputCheck(prompt);
 */
export function extractUserText(messages: ReadonlyArray<Message>): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];

    if (message.role !== "user") {
      continue;
    }

    if (typeof message.content === "string") {
      return message.content;
    }

    if (Array.isArray(message.content)) {
      return message.content
        .filter((part) => part.type === "text")
        .map((part) => (part as { text: string }).text)
        .join("\n");
    }
  }

  return "";
}
