import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AgentExecuteOptions } from "../contracts/agent/agent-options.type";
import type { Attachment } from "../contracts/attachment.type";
import type { ContentPart } from "../contracts/content-part.type";
import type { Message } from "../contracts/conversation-message.type";
import type { Placeholders } from "../contracts/placeholders.type";
import { InvalidRequestError } from "../errors";
import { extractJsonSchema, prepareAttachmentPart } from "../utils";
import type { AgentConfig } from "./agent-config.type";

/**
 * Outcome of `buildAgentInputMessages` — the seeded message list and
 * the JSON Schema cached for every trip's
 * `ModelCallOptions.responseSchema`. `responseSchema` is `undefined`
 * when the caller didn't ask for structured output.
 */
export type AgentInputBuildResult = {
  messages: Message[];
  responseSchema?: Record<string, unknown>;
};

/**
 * Assemble the seed conversation for an agent execution. Runs exactly
 * once per run — subsequent trips append to the same message list.
 *
 * Responsibilities (previously three methods on `Execution`):
 * 1. Merge factory + per-call placeholders.
 * 2. Resolve the system prompt (string, contract, or absent).
 * 3. When an output schema is supplied:
 *    - cache its JSON Schema form for `ModelCallOptions.responseSchema`
 *      so native-structured-output providers enforce it at the token
 *      level;
 *    - fall back to a soft system-prompt instruction for providers
 *      that don't advertise `structuredOutput` capability.
 * 4. Append caller-supplied `history` (e.g. session-level prior turns).
 * 5. Shape the user message — plain string in the common case,
 *    multipart `ContentPart[]` when `attachments` are present. Image
 *    attachments require model vision capability; mismatch throws
 *    `InvalidRequestError` here rather than failing opaquely at the
 *    provider.
 *
 * Extracted from the `Execution` class to isolate the declarative
 * input-shaping phase from the stateful trip loop.
 */
export async function buildAgentInputMessages<TOutput>(params: {
  config: AgentConfig<TOutput>;
  input: string;
  options?: AgentExecuteOptions<TOutput>;
}): Promise<AgentInputBuildResult> {
  const { config, input, options } = params;

  const placeholders: Placeholders = {
    ...config.placeholders,
    ...options?.placeholders,
  };

  const systemPrompt = options?.systemPrompt ?? config.systemPrompt;
  let systemContent = "";

  if (typeof systemPrompt === "string") {
    systemContent = systemPrompt;
  } else if (systemPrompt) {
    systemContent = systemPrompt.resolve(placeholders);
  }

  const { responseSchema, instruction } = resolveStructuredOutput({
    outputSchema: options?.output ?? config.output,
    overrideResponseSchema: options?.responseSchema,
    modelSupportsStructuredOutput: Boolean(config.model.capabilities?.structuredOutput),
  });

  if (instruction) {
    systemContent = systemContent ? `${systemContent}\n\n${instruction}` : instruction;
  }

  const messages: Message[] = [];

  if (systemContent) {
    messages.push({ role: "system", content: systemContent });
  }

  if (options?.history) {
    messages.push(...options.history);
  }

  const userContent = await buildUserMessageContent({
    input,
    attachments: options?.attachments,
    modelName: config.model.name,
    modelSupportsVision: Boolean(config.model.capabilities?.vision),
  });

  messages.push({ role: "user", content: userContent });

  return { messages, responseSchema };
}

/**
 * Build the user message `content` field. Plain string when no
 * attachments (the hot path) — keeps wire payloads small. Multipart
 * `ContentPart[]` when attachments exist: input text first, resolved
 * parts in declaration order.
 */
async function buildUserMessageContent(params: {
  input: string;
  attachments?: Attachment[];
  modelName: string;
  modelSupportsVision: boolean;
}): Promise<string | ContentPart[]> {
  const { input, attachments, modelName, modelSupportsVision } = params;

  if (!attachments || attachments.length === 0) {
    return input;
  }

  const parts: ContentPart[] = await Promise.all(
    attachments.map((attachment) => prepareAttachmentPart(attachment)),
  );

  const hasImage = parts.some((part) => part.type === "image");

  if (hasImage && !modelSupportsVision) {
    throw new InvalidRequestError(
      `Model "${modelName}" does not declare vision capability — image attachments are not supported`,
      { context: { modelName } },
    );
  }

  return [{ type: "text", text: input }, ...parts];
}

/**
 * When the caller supplied an `output` schema, resolve two artifacts:
 *
 * - `responseSchema` — extracted JSON Schema to attach on every trip.
 *   Adapters that natively support structured output (OpenAI's
 *   `response_format: json_schema`) consume it; others ignore it.
 * - `instruction` — a soft fallback appended to the system prompt
 *   **only** for models without native structured-output capability.
 *   Capable adapters skip it to save tokens and avoid redundancy.
 */
function resolveStructuredOutput(params: {
  outputSchema?: StandardSchemaV1<unknown>;
  overrideResponseSchema?: Record<string, unknown>;
  modelSupportsStructuredOutput: boolean;
}): {
  responseSchema?: Record<string, unknown>;
  instruction?: string;
} {
  const { outputSchema, overrideResponseSchema, modelSupportsStructuredOutput } = params;

  if (!outputSchema) {
    return {};
  }

  const responseSchema = overrideResponseSchema ?? extractJsonSchema(outputSchema);

  if (modelSupportsStructuredOutput) {
    return { responseSchema };
  }

  const schemaHint = responseSchema
    ? `\n\nThe response MUST match this JSON Schema:\n${JSON.stringify(responseSchema, null, 2)}`
    : "";

  const instruction = [
    "You MUST respond with a single valid JSON value only.",
    "Do not wrap it in markdown code fences. Do not include prose, commentary, or explanation — JSON only.",
    schemaHint,
  ]
    .join("")
    .trim();

  return { responseSchema, instruction };
}
