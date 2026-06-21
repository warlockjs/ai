import type { ContentPart } from "./content-part.type";
import type { ModelToolCallRequest } from "./model-tool-call-request.type";

/**
 * A single message in a conversation history.
 *
 * The `tool` role is used to return a tool's output to the model on the next trip.
 * When the role is `assistant` and the model requested tool calls, `toolCalls`
 * is populated so providers can reconstruct the original tool_calls message.
 *
 * `content` is `string` for plain text (the common case) or `ContentPart[]`
 * when the message carries attachments (vision input, files, etc.). Adapters
 * are expected to handle both shapes.
 *
 * @example
 * const messages: Message[] = [
 *   { role: "user", content: "What's the weather in Cairo?" },
 *   { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "getWeather", input: { city: "Cairo" } }] },
 *   { role: "tool", toolCallId: "call_1", content: '{"temp":82}' },
 *   { role: "assistant", content: "It's 82°F in Cairo." },
 * ];
 *
 * @example
 * // Multipart user message with an image
 * const visionMessage: Message = {
 *   role: "user",
 *   content: [
 *     { type: "text", text: "Describe this picture" },
 *     { type: "image", source: { url: "https://example.com/cat.jpg" } },
 *   ],
 * };
 */
export type Message<User = Record<string, unknown>> = {
  /** Message id */
  id?: string;
  /** Who sent this message */
  role: "user" | "assistant" | "system" | "tool";
  /**
   * Message content. A plain string for text-only messages, or a
   * `ContentPart[]` when the message includes attachments. Tool-result
   * messages always use the string form (stringified JSON).
   */
  content: string | ContentPart[];
  /** Provider-generated id — required when role is "tool", links to the assistant's tool_calls */
  toolCallId?: string;
  /** Tool calls requested by the assistant — present when role is "assistant" and the LLM triggered tools */
  toolCalls?: ModelToolCallRequest[];
  /** When this message was created */
  timestamp?: Date;
  /** Arbitrary metadata for application-level use */
  metadata?: Record<string, unknown>;
  /** User info */
  user?: User;
};
