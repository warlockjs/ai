/**
 * A raw tool call request returned by the model during a complete() call or
 * emitted as a chunk during stream(). Agents look up the tool by `name` and
 * correlate the eventual tool-result message back to the model using `id`.
 *
 * @example
 * const req: ModelToolCallRequest = {
 *   id: "call_abc123",
 *   name: "searchWeb",
 *   input: { query: "warlock.js docs" },
 * };
 */
export type ModelToolCallRequest = {
  /** Provider-generated id; agent echoes it on the matching tool-result message */
  id: string;
  /** Registered tool name the model wants to invoke */
  name: string;
  /** Arguments the model produced for the tool */
  input: unknown;
  /**
   * Provenance marker stamped by the framework, NOT the provider.
   * Present only when the agent's stream-time tool-call guard
   * synthesized this request from a JSON envelope the model emitted as
   * literal text in the content channel. Absent means the provider
   * emitted a structured tool call (the normal path).
   *
   * Consumers branch on this for:
   * - **Telemetry**: dashboards measure per-model leak rate as
   *   `recovered / total`. High rates are a strong signal to drop the
   *   model from the rotation.
   * - **Cost auditing**: recovered calls cost the same as real ones
   *   in terms of tool execution, but the *prompt tokens* that produced
   *   them were wasted on text the user couldn't see. Worth tracking.
   *
   * The framework treats it as informational only — recovered calls
   * dispatch through the same path as real ones with no behavioral
   * difference.
   */
  recoveredFrom?: "stream-text";
  /**
   * Opaque, provider-specific data the adapter must round-trip back to
   * the provider on the *next* request for this tool call to remain
   * valid. The framework treats it as a black box: it never reads or
   * mutates the contents — it only guarantees the object survives from
   * the model response, through the assistant history message, back
   * into the adapter's next request.
   *
   * Concrete need: Gemini "thinking" models attach a `thoughtSignature`
   * to every `functionCall` part and **reject the follow-up request
   * with a 400** if it is missing. Anthropic extended-thinking
   * signatures are the same shape of problem. Vendor-neutral by
   * design — only the owning adapter knows the keys.
   *
   * Absent for providers (OpenAI, Bedrock, Ollama) that need no echo.
   */
  providerMetadata?: Record<string, unknown>;
};
