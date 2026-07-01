import type { Usage } from "./result/usage.type";

/**
 * USD pricing for a text-to-speech model. TTS providers meter one of
 * two ways, and this single shape covers both so the cost folds into
 * the same `Usage.cost` rollup the text + image paths use:
 *
 * - **Per-character** (OpenAI `tts-1` / `tts-1-hd`): billed per input
 *   character. Set `perMillionCharacters` (USD per 1,000,000 chars).
 * - **Token-metered** (OpenAI `gpt-4o-mini-tts`): billed per input/output
 *   token like a chat model. Set `input` / `output` (USD per 1M tokens).
 *
 * Per-character wins when both are set. Nothing set → `Usage.cost`
 * stays `undefined` (honest "cost unknown", not a false zero).
 *
 * @example
 * const pricing: SpeechModelPricing = { perMillionCharacters: 15 }; // tts-1
 */
export type SpeechModelPricing = {
  /** USD per 1M input characters — per-character-metered TTS. */
  perMillionCharacters?: number;
  /** USD per 1M input tokens — token-metered TTS. */
  input?: number;
  /** USD per 1M output (audio) tokens — token-metered TTS. */
  output?: number;
};

/**
 * Generated audio, normalized to a discriminated shape (mirrors
 * {@link GeneratedImage}). TTS providers return raw audio bytes, so the
 * `base64` variant is the only one today; the union leaves room for a
 * future hosted-`url` variant without a breaking change.
 */
export type GeneratedAudio = {
  type: "base64";
  /** Base64-encoded audio bytes. */
  base64: string;
  /** IANA media type (e.g. `"audio/mpeg"`, `"audio/wav"`). */
  mediaType: string;
};

/**
 * Options for a single {@link SpeechModelContract.generate} request.
 * Provider-neutral; each adapter maps the ones its API supports.
 */
export type SpeechOptions = {
  /** Voice id/name (e.g. OpenAI `"alloy"`, `"verse"`). Defaults per model config. */
  voice?: string;
  /** Output container (`"mp3"` / `"opus"` / `"aac"` / `"flac"` / `"wav"` / `"pcm"`). */
  format?: string;
  /** Playback speed multiplier (provider range, e.g. OpenAI `0.25`–`4.0`). */
  speed?: number;
  /** Extra steering of tone/delivery (OpenAI `gpt-4o-mini-tts` `instructions`). */
  instructions?: string;
  /** Cancellation handle wired into the provider request where supported. */
  signal?: AbortSignal;
  /** Provider-specific escape hatch — forwarded verbatim. */
  [key: string]: unknown;
};

/**
 * Raw result of a {@link SpeechModelContract.generate} call — low-level
 * (like `EmbedderContract.embed`): returns the audio + usage and THROWS
 * a typed `AIError` on failure. The never-throws `{ data, error, usage,
 * report }` envelope is added by the `ai.speech()` facade verb.
 */
export type SpeechGenerationResponse = {
  audio: GeneratedAudio;
  /**
   * Token usage when the provider meters per token (gpt-4o-mini-tts);
   * `{ input: 0, output: 0, total: 0 }` for per-character-metered models,
   * whose spend is priced from {@link characters}.
   */
  usage: Usage;
  /** Number of input characters synthesized — drives per-character cost. */
  characters: number;
};

/**
 * Provider-neutral contract for a text-to-speech model — the audio
 * sibling of {@link ImageModelContract}. Produced by an adapter's
 * optional `speech?(config)` factory and consumed by `ai.speech()`.
 *
 * @example
 * const tts = openai.speech({ name: "tts-1", voice: "alloy" });
 * const { audio } = await tts.generate("Welcome aboard.");
 */
export interface SpeechModelContract {
  /** Model identifier (e.g. `"tts-1"`, `"gpt-4o-mini-tts"`). */
  readonly name: string;
  /** Provider this model belongs to (e.g. `"openai"`). */
  readonly provider: string;
  /** Per-character or per-token USD pricing; folded into `Usage.cost` by `ai.speech()`. */
  readonly pricing?: SpeechModelPricing;

  /** Synthesize speech from text. Throws a typed `AIError` on failure. */
  generate(text: string, options?: SpeechOptions): Promise<SpeechGenerationResponse>;
}

/**
 * Configuration passed to an adapter's `speech()` factory. Mirrors
 * {@link ImageModelConfig}: `name` + an optional per-model `pricing`
 * override + a default `voice`, with provider-specific keys on the
 * index signature.
 */
export type SpeechModelConfig = {
  name: string;
  /** Per-model USD pricing override; wins over the SDK-level registry. */
  pricing?: SpeechModelPricing;
  /** Default voice when a call omits `options.voice`. */
  voice?: string;
  [key: string]: unknown;
};
