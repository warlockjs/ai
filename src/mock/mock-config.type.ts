import type { Usage } from "../contracts";
import type { FinishReason } from "../contracts/finish-reason.type";
import type { ModelToolCallRequest } from "../contracts/model-tool-call-request.type";
import type { ModelCapabilities } from "../contracts/model.contract";

/**
 * Configuration for a single mock model response.
 * Responses are consumed in order — last one repeats if list is exhausted.
 */
export type MockModelResponse = {
  content: string;
  finishReason?: FinishReason;
  usage?: Usage;
  toolCalls?: ModelToolCallRequest[];
  /** Simulate a delay in ms before resolving */
  delay?: number;
  /** Throw this error instead of returning a response */
  error?: Error;
};

export type MockSDKConfig = {
  /** Responses to return in sequence. Last one repeats when exhausted. */
  responses?: MockModelResponse[];
  /** Default model name reported by mock models */
  defaultModelName?: string;
  /**
   * Capability flags reported by every model this mock SDK creates.
   * Tests use this to exercise capability-gated agent behavior (e.g.
   * vision attachments, native structured output) without standing up
   * a real provider.
   */
  capabilities?: ModelCapabilities;
};
