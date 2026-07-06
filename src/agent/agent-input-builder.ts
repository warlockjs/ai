import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AgentExecuteOptions } from "../contracts/agent/agent-options.type";
import type { AttachmentPolicy } from "../contracts/attachment-policy.type";
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
  /**
   * The resolved system-prompt text actually sent as the `role: "system"`
   * message (persona + instructions + any auto-appended structured-output
   * instruction). Captured for observability; absent when the agent ran
   * without a system prompt.
   */
  systemPrompt?: string;
  /**
   * Registry name of the `SystemPromptContract` the agent resolved, read from
   * its `meta().name`. Present only when the agent ran against a *named*
   * prompt (one registered in `ai.prompts`); absent for a raw-string prompt,
   * an anonymous contract, or no prompt at all. Lets observers attribute a run
   * to a specific prompt in the registry.
   */
  promptName?: string;
  /**
   * Registry version label of the named prompt the agent resolved, read from
   * its `meta().version` (defaulting to `"1"` when the prompt carries a name
   * but no explicit version, mirroring the registry's default). Present only
   * alongside {@link AgentInputBuildResult.promptName}.
   */
  promptVersion?: string;
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
  let promptName: string | undefined;
  let promptVersion: string | undefined;

  if (typeof systemPrompt === "string") {
    systemContent = systemPrompt;
  } else if (systemPrompt) {
    // A lazily-compiled prompt (`systemPrompt.refined(...)`) finishes its
    // async work here, before the synchronous `resolve()` below — a no-op for
    // plain builders, and never throws (a failed refinement falls back to the
    // original text).
    if (typeof systemPrompt.materialize === "function") {
      await systemPrompt.materialize();
    }

    systemContent = systemPrompt.resolve(placeholders);

    // Capture prompt-version linkage from the contract's metadata: a *named*
    // prompt (one addressable in `ai.prompts`) stamps `promptName@version`
    // onto the run's report so observers can group runs by the exact prompt
    // version that produced them. Anonymous prompts carry no name and are
    // left unlinked.
    const meta = systemPrompt.meta();

    if (meta?.name) {
      promptName = meta.name;
      promptVersion = meta.version ?? "1";
    }
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
    attachmentPolicy: options?.attachmentPolicy ?? config.attachmentPolicy,
    modelName: config.model.name,
    modelSupportsVision: Boolean(config.model.capabilities?.vision),
    modelSupportsPdf: Boolean(config.model.capabilities?.pdf),
    modelSupportsAudio: Boolean(config.model.capabilities?.audio),
  });

  messages.push({ role: "user", content: userContent });

  return {
    messages,
    responseSchema,
    systemPrompt: systemContent || undefined,
    promptName,
    promptVersion,
  };
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
  attachmentPolicy?: AttachmentPolicy;
  modelName: string;
  modelSupportsVision: boolean;
  modelSupportsPdf: boolean;
  modelSupportsAudio: boolean;
}): Promise<string | ContentPart[]> {
  const {
    input,
    attachments,
    attachmentPolicy,
    modelName,
    modelSupportsVision,
    modelSupportsPdf,
    modelSupportsAudio,
  } = params;

  if (!attachments || attachments.length === 0) {
    return input;
  }

  const parts: ContentPart[] = await Promise.all(
    attachments.map((attachment) => prepareAttachmentPart(attachment, attachmentPolicy)),
  );

  // Capability gate per modality (A2) — reject an attachment the model
  // can't consume here, with a clear message, rather than failing opaquely
  // at the provider.
  assertModality(parts, "image", modelSupportsVision, "vision", modelName);
  assertModality(parts, "pdf", modelSupportsPdf, "pdf", modelName);
  assertModality(parts, "audio", modelSupportsAudio, "audio", modelName);

  return [{ type: "text", text: input }, ...parts];
}

/** Throw when a modality is present but the model doesn't declare it. */
function assertModality(
  parts: ContentPart[],
  partType: ContentPart["type"],
  supported: boolean,
  capability: string,
  modelName: string,
): void {
  if (!supported && parts.some((part) => part.type === partType)) {
    throw new InvalidRequestError(
      `Model "${modelName}" does not declare ${capability} capability — ${partType} attachments are not supported`,
      { context: { modelName } },
    );
  }
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
