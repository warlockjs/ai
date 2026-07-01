import type { Usage } from "./result/usage.type";

/**
 * USD pricing for a speech-to-text (transcription) model. STT providers
 * meter one of two ways; this single shape covers both so the cost
 * folds into the same `Usage.cost` rollup as text / image / speech:
 *
 * - **Per-minute** (OpenAI `whisper-1`): billed per minute of input
 *   audio. Set `perMinute` (USD per audio-minute).
 * - **Token-metered** (OpenAI `gpt-4o-transcribe`): billed per
 *   input/output token. Set `input` / `output` (USD per 1M tokens).
 *
 * Per-minute wins when both are set. Nothing set → `Usage.cost` stays
 * `undefined`.
 *
 * @example
 * const pricing: TranscriptionModelPricing = { perMinute: 0.006 }; // whisper-1
 */
export type TranscriptionModelPricing = {
  /** USD per minute of input audio — per-minute-metered STT. */
  perMinute?: number;
  /** USD per 1M input (audio) tokens — token-metered STT. */
  input?: number;
  /** USD per 1M output (text) tokens — token-metered STT. */
  output?: number;
};

/** One timestamped segment of a transcription (when the provider returns segments). */
export type TranscriptionSegment = {
  text: string;
  /** Segment start time in seconds. */
  start?: number;
  /** Segment end time in seconds. */
  end?: number;
};

/**
 * The audio to transcribe — inlined base64 bytes with an explicit IANA
 * media type, plus an optional filename (some providers infer the codec
 * from the extension). Read a file to base64 before calling, or pass
 * in-memory bytes; this keeps the verb provider-neutral and
 * serializable (no `fs` coupling in core).
 *
 * @example
 * const audio: AudioInput = { base64: buf.toString("base64"), mediaType: "audio/mpeg", filename: "note.mp3" };
 */
export type AudioInput = {
  base64: string;
  mediaType: string;
  filename?: string;
};

/** Options for a single {@link TranscriptionModelContract.transcribe} request. */
export type TranscribeOptions = {
  /** BCP-47 language hint (e.g. `"en"`) — improves accuracy + latency. */
  language?: string;
  /** Optional priming prompt (spelling/style hints). */
  prompt?: string;
  /** Provider response format override (e.g. `"verbose_json"` for segments + duration). */
  format?: string;
  /** Cancellation handle wired into the provider request where supported. */
  signal?: AbortSignal;
  /** Provider-specific escape hatch — forwarded verbatim. */
  [key: string]: unknown;
};

/**
 * Raw result of a {@link TranscriptionModelContract.transcribe} call —
 * low-level (throws a typed `AIError` on failure). The never-throws
 * envelope is added by the `ai.transcribe()` facade verb.
 */
export type TranscriptionResponse = {
  /** The full transcript text. */
  text: string;
  /** Timestamped segments when the provider returns them (verbose mode). */
  segments?: TranscriptionSegment[];
  /** Input audio duration in seconds — drives per-minute cost when present. */
  durationSeconds?: number;
  /**
   * Token usage when the provider meters per token (gpt-4o-transcribe);
   * `{ input: 0, output: 0, total: 0 }` for per-minute-metered models,
   * whose spend is priced from {@link durationSeconds}.
   */
  usage: Usage;
};

/**
 * Provider-neutral contract for a speech-to-text model — the inverse of
 * {@link SpeechModelContract}. Produced by an adapter's optional
 * `transcribe?(config)` factory and consumed by `ai.transcribe()`.
 *
 * @example
 * const stt = openai.transcribe({ name: "whisper-1" });
 * const { text } = await stt.transcribe({ base64, mediaType: "audio/mpeg" });
 */
export interface TranscriptionModelContract {
  /** Model identifier (e.g. `"whisper-1"`, `"gpt-4o-transcribe"`). */
  readonly name: string;
  /** Provider this model belongs to (e.g. `"openai"`). */
  readonly provider: string;
  /** Per-minute or per-token USD pricing; folded into `Usage.cost` by `ai.transcribe()`. */
  readonly pricing?: TranscriptionModelPricing;

  /** Transcribe audio to text. Throws a typed `AIError` on failure. */
  transcribe(audio: AudioInput, options?: TranscribeOptions): Promise<TranscriptionResponse>;
}

/**
 * Configuration passed to an adapter's `transcribe()` factory. Mirrors
 * {@link SpeechModelConfig}: `name` + an optional per-model `pricing`
 * override, with provider-specific keys on the index signature.
 */
export type TranscriptionModelConfig = {
  name: string;
  /** Per-model USD pricing override; wins over the SDK-level registry. */
  pricing?: TranscriptionModelPricing;
  [key: string]: unknown;
};
