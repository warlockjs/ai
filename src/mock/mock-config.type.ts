import type { Usage } from "../contracts";
import type { FinishReason } from "../contracts/finish-reason.type";
import type { ImageModelPricing } from "../contracts/image-model.contract";
import type { ModelToolCallRequest } from "../contracts/model-tool-call-request.type";
import type { ModelCapabilities } from "../contracts/model.contract";
import type { SpeechModelPricing } from "../contracts/speech-model.contract";
import type { TranscriptionModelPricing } from "../contracts/transcription-model.contract";
import type { MockImageResponse } from "./mock-image-model";
import type { MockSpeechResponse } from "./mock-speech-model";
import type { MockTranscriptionResponse } from "./mock-transcription-model";

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
  /**
   * Scripted responses for `image()` models this mock SDK creates,
   * consumed in sequence (last repeats when exhausted). Omitted = a
   * single default 1×1 PNG.
   */
  imageResponses?: MockImageResponse[];
  /**
   * Pricing stamped on every `image()` model this mock SDK creates, so
   * tests can exercise the per-image / per-token cost rollup.
   */
  imagePricing?: ImageModelPricing;
  /** Scripted responses for `speech()` (TTS) models. Omitted = a default audio blob. */
  speechResponses?: MockSpeechResponse[];
  /** Pricing stamped on every `speech()` model — exercise the per-character / per-token rollup. */
  speechPricing?: SpeechModelPricing;
  /** Scripted responses for `transcribe()` (STT) models. Omitted = a default transcript. */
  transcriptionResponses?: MockTranscriptionResponse[];
  /** Pricing stamped on every `transcribe()` model — exercise the per-minute / per-token rollup. */
  transcriptionPricing?: TranscriptionModelPricing;
};
