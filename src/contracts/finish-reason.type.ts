/**
 * Reasons the LLM stopped generating. Shared across model responses,
 * streaming chunks, and LLM trip records.
 *
 * @example
 * const reason: FinishReason = "stop";
 *
 * @example
 * if (response.finishReason === "tool_calls") {
 *   // Execute requested tools and continue the trip loop
 * }
 */
export type FinishReason = "stop" | "tool_calls" | "length" | "error";
