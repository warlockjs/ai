import type { Message } from "./conversation-message.type";
import type { FinishReason } from "./finish-reason.type";
import type { ModelToolCallRequest } from "./model-tool-call-request.type";
import type { ModelPricing } from "./result/model-pricing.type";
import type { Usage } from "./result/usage.type";
import type { ToolConfig } from "./tool.contract";

/**
 * Options passed to model.complete() or model.stream().
 *
 * `tools` is first-class so every model implementation is responsible for
 * converting the vendor-neutral ToolConfig into its own provider format
 * (OpenAI functions, Anthropic tools, etc.).
 *
 * @example
 * await model.complete(messages, {
 *   temperature: 0.2,
 *   maxTokens: 1000,
 *   tools: [weatherTool, searchTool],
 * });
 */
export type ModelCallOptions = {
  temperature?: number;
  maxTokens?: number;
  /** Tools to expose to the LLM on this call. Each model converts to its provider format. */
  tools?: ToolConfig<unknown, unknown>[];
  /**
   * JSON Schema the response must match. Adapters that declare
   * `capabilities.structuredOutput` forward this to the provider's native
   * structured-output mechanism (OpenAI `response_format: json_schema`,
   * Anthropic tool-use trick, etc.). Adapters without native support may
   * ignore this field — the agent still injects a soft JSON instruction
   * into the system prompt as a fallback.
   */
  responseSchema?: Record<string, unknown>;
  /**
   * Cancellation handle. Adapters that wire it into their HTTP client
   * (OpenAI SDK, fetch) will abort the in-flight request when
   * `signal.aborted` flips. Adapters without support may ignore it;
   * the agent still honors the signal at trip boundaries regardless.
   */
  signal?: AbortSignal;
  /**
   * Reasoning / thinking-effort control for reasoning-capable models.
   * `effort` maps to OpenAI `reasoning_effort`; `maxTokens` caps the
   * Anthropic extended-thinking budget. `effort: "none"` runs the model
   * **without reasoning, explicitly** — distinct from an absent `effort`
   * (which requests the provider default, i.e. the model may still reason
   * server-side). It is the only mode in which OpenAI's gpt-5 / o-series
   * models accept function tools on the Chat Completions API. Adapters
   * whose `capabilities.reasoning` is absent/false ignore this rather than
   * forwarding unsupported params. Absent = provider default.
   *
   * @example
   * await model.complete(messages, { reasoning: { effort: "high" } });
   *
   * @example
   * // gpt-5 / o-series + tools: turn reasoning off so tools are accepted.
   * await model.complete(messages, { reasoning: { effort: "none" }, tools });
   */
  reasoning?: {
    effort?: ReasoningEffort;
    maxTokens?: number;
  };
  /**
   * Vendor-neutral prompt-cache WRITE breakpoint hint. Adapters with
   * `capabilities.promptCaching` translate `breakpoints` into provider
   * cache markers (Anthropic `cache_control`); others ignore it.
   * Read-side accounting (`Usage.cachedTokens`) works without this — it
   * only controls WRITE placement. Absent = provider default (no
   * explicit breakpoints).
   *
   * @example
   * await model.complete(messages, { cacheControl: { breakpoints: 1 } });
   */
  cacheControl?: {
    breakpoints?: number;
  };
  /** Additional provider-specific options */
  [key: string]: unknown;
};

/**
 * Reasoning/thinking-effort levels for reasoning-capable models. Maps to
 * the provider-native control (OpenAI `reasoning_effort`); adapters
 * without reasoning support ignore it.
 *
 * `"none"` means **run without reasoning, explicitly** — not "provider
 * default" (that is what an absent `effort` requests). It exists because
 * OpenAI's gpt-5 / o-series models reject function tools on Chat
 * Completions while reasoning is active: the endpoint accepts tools only
 * when `reasoning_effort` is sent as `"none"` (the alternative is the
 * Responses API). The OpenAI adapter forwards `"none"` verbatim so
 * tool-using agents work on those models; budget-based adapters
 * (Anthropic / Google `thinking`, Ollama `think`, Bedrock) read `"none"`
 * as "reasoning off" and disable the thinking channel.
 */
export type ReasoningEffort = "low" | "medium" | "high" | "none";

/**
 * Declarative feature flags a `ModelContract` may expose so the agent can
 * short-circuit redundant work when the provider already enforces a
 * behavior natively.
 *
 * @example
 * class OpenAIModel implements ModelContract {
 *   public readonly capabilities: ModelCapabilities = { structuredOutput: true };
 * }
 */
export type ModelCapabilities = {
  /**
   * True when the adapter forwards `ModelCallOptions.responseSchema` to
   * the provider's native structured-output mechanism and the provider
   * guarantees a matching response at the token level. When true, the
   * agent skips the soft "respond in JSON" system-prompt injection.
   */
  structuredOutput?: boolean;
  /**
   * True when the adapter accepts `ContentPart` entries of type
   * `"image"` in user messages and the provider can interpret them
   * (vision models). When false/absent and the caller passes image
   * attachments, the agent throws upfront rather than silently
   * dropping them at the wire layer.
   */
  vision?: boolean;
  /**
   * True when the adapter exposes provider reasoning / extended-thinking
   * and forwards `ModelCallOptions.reasoning`. When false/absent the
   * agent ignores reasoning options rather than sending unsupported
   * params to the provider.
   */
  reasoning?: boolean;
  /**
   * True when the adapter honors `ModelCallOptions.cacheControl` write
   * breakpoints and reports `Usage.cachedTokens` / `Usage.cacheWriteTokens`.
   * When false/absent the agent skips emitting cache breakpoints.
   */
  promptCaching?: boolean;
  /**
   * True when the adapter accepts audio `ContentPart` input (A2). The
   * agent gates `{ type: "audio" }` attachments on this flag — when
   * false/absent it throws upfront rather than dropping them at the wire
   * layer (mirrors `vision`). Wired end-to-end: audio `ContentPart` +
   * attachment resolution exist; today Google (Gemini, via `inlineData`)
   * declares it.
   */
  audio?: boolean;
  /**
   * True when the adapter accepts PDF / document `ContentPart` input (A2).
   * The agent gates `{ type: "pdf" }` attachments on this flag — when
   * false/absent it throws upfront (mirrors `vision`). Wired end-to-end:
   * Anthropic (`document` block), Bedrock Converse (`document` block), and
   * Google (Gemini `inlineData`) map PDF parts.
   */
  pdf?: boolean;
};

/**
 * Full response from a non-streaming model call.
 *
 * @example
 * const response: ModelResponse = {
 *   content: "Here is the answer...",
 *   finishReason: "stop",
 *   usage: { input: 120, output: 80, total: 200 },
 * };
 */
export type ModelResponse = {
  content: string;
  finishReason: FinishReason;
  usage: Usage;
  /** Tool calls requested by the model, present when finishReason is "tool_calls" */
  toolCalls?: ModelToolCallRequest[];
};

/**
 * A single chunk emitted during a streaming model call.
 *
 * @example
 * for await (const chunk of model.stream(messages)) {
 *   if (chunk.type === "delta") process.stdout.write(chunk.content);
 *   else if (chunk.type === "done") console.log(chunk.usage.total, "tokens");
 * }
 */
export type ModelStreamChunk =
  | { type: "delta"; content: string }
  | {
      type: "tool-call";
      id: string;
      name: string;
      input: unknown;
      /**
       * Opaque provider round-trip data for this call — see
       * `ModelToolCallRequest.providerMetadata`. The agent copies it
       * verbatim onto the assembled `ModelToolCallRequest` so streamed
       * tool calls round-trip identically to non-streamed ones.
       */
      providerMetadata?: Record<string, unknown>;
    }
  | { type: "done"; finishReason: FinishReason; usage: Usage };

/**
 * Contract every SDK model instance must implement.
 * Created by SDKAdapterContract.model() — internally holds the SDK client
 * so agents only need to pass the model, not the SDK.
 *
 * @example
 * const model = ai.openai.model({ name: "gpt-4o", temperature: 0.7 });
 * const response = await model.complete(messages);
 *
 * @example
 * for await (const chunk of model.stream(messages)) {
 *   if (chunk.type === "delta") process.stdout.write(chunk.content);
 * }
 */
export interface ModelContract {
  /** Model identifier (e.g. "gpt-4o", "claude-3-5-sonnet-20241022") */
  readonly name: string;
  /** Provider this model belongs to (e.g. "openai", "anthropic") */
  readonly provider: string;
  /**
   * Optional feature flags so callers (notably the agent) can skip work
   * the provider already handles natively. Absent = treat every flag as
   * `false`.
   */
  readonly capabilities?: ModelCapabilities;

  /**
   * Per-million-token USD pricing. When set, the framework computes
   * `Usage.costUSD` at emit time for every trip / tool / report node
   * touching this model. Resolution: per-model `pricing` (here) >
   * SDK-level `pricing[name]` registry > undefined (no cost computed).
   *
   * Critical for multi-tenant projects where pricing is contract-
   * specific or runtime-resolved — pass per-model when you need to
   * override the SDK registry for a single agent.
   */
  readonly pricing?: ModelPricing;

  /**
   * Send messages and receive a full response once generation is complete.
   */
  complete(messages: Message[], options?: ModelCallOptions): Promise<ModelResponse>;

  /**
   * Send messages and stream the response chunk by chunk.
   */
  stream(messages: Message[], options?: ModelCallOptions): AsyncIterable<ModelStreamChunk>;
}
