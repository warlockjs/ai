import type { EmbedderConfig, EmbedderContract } from "./embedder.contract";
import type { ImageModelConfig, ImageModelContract } from "./image-model.contract";
import type { ModelContract } from "./model.contract";
import type { ModelPricing } from "./result/model-pricing.type";
import type { SpeechModelConfig, SpeechModelContract } from "./speech-model.contract";
import type {
  TranscriptionModelConfig,
  TranscriptionModelContract,
} from "./transcription-model.contract";

/**
 * Configuration passed to SDKAdapterContract.model() to create a model instance.
 *
 * @example
 * const model = ai.openai.model({ name: "gpt-4o", temperature: 0.7 });
 *
 * @example
 * // Per-model pricing override (multi-tenant projects where the
 * // rate is contract-specific or runtime-resolved):
 * openai.model({
 *   name: "gpt-4o",
 *   pricing: { input: 2.5, output: 10 },
 * });
 */
export type ModelConfig = {
  /** Model identifier (e.g. "gpt-4o", "claude-3-5-sonnet-20241022") */
  name: string;
  /** Sampling temperature (0–2). Higher = more creative, lower = more focused */
  temperature?: number;
  /** Maximum tokens to generate in the response */
  maxTokens?: number;
  /**
   * Per-model USD pricing override. Wins over any SDK-level pricing
   * registry — useful in multi-tenant projects where the rate is
   * contract-specific or runtime-resolved. When omitted, the adapter
   * falls back to its SDK-level registry (if any); when neither is
   * configured, `Usage.cost` stays `undefined` (honest absence, not
   * false zero).
   */
  pricing?: ModelPricing;
  /** Additional provider-specific configuration */
  [key: string]: unknown;
};

/**
 * What every SDK adapter factory returns.
 * Becomes `ai.[sdkName]` on the AI namespace (e.g. `ai.openai`, `ai.anthropic`).
 *
 * @example
 * // OpenAI adapter registered as ai.openai
 * const model = ai.openai.model({ name: "gpt-4o" });
 * const tokens = await ai.openai.count("Hello world", "gpt-4o");
 *
 * @example
 * // Mock adapter for tests
 * const mock = MockSDK();
 * const model = mock.model({ name: "mock-model" });
 */
export interface SDKAdapterContract {
  /**
   * Create a model instance with the given configuration.
   * The returned ModelContract is passed to agents, tools, and other primitives.
   */
  model(config: ModelConfig): ModelContract;

  /**
   * Count the number of tokens in the given text.
   * Implementation is deferred to each adapter package.
   *
   * @param text - The text to tokenize and count
   * @param model - Optional model name; affects tokenizer selection for some providers
   * @returns Promise resolving to the token count
   */
  count(text: string, model?: string): Promise<number>;

  /**
   * Create an embedder bound to this SDK's client. Optional — not every
   * provider supports embeddings (e.g. a hypothetical Anthropic adapter
   * today). Consumers should check for presence before calling.
   *
   * @example
   * const embedder = openai.embedder({ name: "text-embedding-3-small" });
   * const { vector } = await embedder.embed("Hello world");
   */
  embedder?(config: EmbedderConfig): EmbedderContract;

  /**
   * Create an image-generation model bound to this SDK's client.
   * Optional — only providers with an image API expose it (OpenAI,
   * Google today; Anthropic/Bedrock/Ollama do not). The structural
   * absence of this method IS the capability guard: an adapter that
   * can't generate images simply doesn't define it, so `ai.someSdk.image(...)`
   * is a compile-time error rather than a silent runtime failure.
   * Hand the returned model to `ai.image({ model, prompt })`.
   *
   * @example
   * const model = openai.image({ name: "gpt-image-1" });
   * const { data } = await ai.image({ model, prompt: "a red bicycle" });
   */
  image?(config: ImageModelConfig): ImageModelContract;

  /**
   * Create a text-to-speech model bound to this SDK's client, for use
   * with `ai.speech({ model, text })`. Optional — only providers with a
   * TTS API expose it. Structural absence is the capability guard.
   *
   * @example
   * const tts = openai.speech({ name: "tts-1", voice: "alloy" });
   * const { data } = await ai.speech({ model: tts, text: "Hello" });
   */
  speech?(config: SpeechModelConfig): SpeechModelContract;

  /**
   * Create a speech-to-text (transcription) model bound to this SDK's
   * client, for use with `ai.transcribe({ model, audio })`. Optional —
   * only providers with an STT API expose it.
   *
   * @example
   * const stt = openai.transcribe({ name: "whisper-1" });
   * const { data } = await ai.transcribe({ model: stt, audio });
   */
  transcribe?(config: TranscriptionModelConfig): TranscriptionModelContract;
}
