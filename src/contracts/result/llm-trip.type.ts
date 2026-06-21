import type { AIError } from "../../errors/ai-error";
import type { FinishReason } from "../finish-reason.type";
import type { ToolCall } from "./tool-call.type";
import type { Usage } from "./usage.type";

/**
 * A single LLM round-trip within an agent execution.
 * An agent may make multiple trips when tools are called.
 *
 * @example
 * const trip: LLMTrip = {
 *   index: 0,
 *   input: "Search for the latest AI news",
 *   output: "I'll search for that...",
 *   finishReason: "tool_calls",
 *   duration: 850,
 *   usage: { input: 120, output: 45, total: 165 },
 *   toolCalls: [{ tripIndex: 0, name: "searchWeb", input: {...}, duration: 300 }],
 * };
 */
export type LLMTrip = {
  /** 0-indexed position of this trip in the execution sequence */
  index: number;
  /** The prompt/input sent to the LLM for this trip */
  input: string;
  /** The raw text output from the LLM */
  output: string;
  /** Why the LLM stopped generating */
  finishReason: FinishReason;
  /** ISO-8601 timestamp when this trip's model call started */
  startedAt: string;
  /** ISO-8601 timestamp when this trip finished (post tool dispatch) */
  endedAt: string;
  /** Duration of this trip in milliseconds */
  duration: number;
  /** Token usage for this trip */
  usage: Usage;
  /** Tool calls made during this trip, if any */
  toolCalls?: ToolCall[];
  /** Typed AI error that occurred during this trip, if any */
  error?: AIError;
};
