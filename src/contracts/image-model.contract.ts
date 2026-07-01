import type { Usage } from "./result/usage.type";

/**
 * USD pricing for an image-generation model. Image providers meter one
 * of two ways, and this single shape covers both so the cost rolls up
 * through the same `Usage.cost` path the text models already use — no
 * second accounting path (only a different INPUT unit).
 *
 * - **Token-metered** (OpenAI `gpt-image-1` family): the request bills
 *   per input/output token exactly like a chat model. Set `input` /
 *   `output` (USD per 1M tokens) and the framework prices the returned
 *   token `Usage` with the standard {@link computeCost} math.
 * - **Per-image-metered** (DALL·E, Google Imagen): the request bills a
 *   flat amount per generated image, with no token usage. Set `perImage`
 *   (USD per image), optionally overridden per requested size via
 *   `perImageBySize`.
 *
 * When BOTH families' fields are set, per-image wins (a provider is one
 * or the other, never both). When nothing is set, `Usage.cost` stays
 * `undefined` — honest "cost unknown", not a false zero.
 *
 * @example
 * // gpt-image-1 — token-metered:
 * const pricing: ImageModelPricing = { input: 5, output: 40 };
 *
 * @example
 * // DALL·E 3 — per-image, size-tiered:
 * const pricing: ImageModelPricing = {
 *   perImage: 0.04,
 *   perImageBySize: { "1024x1024": 0.04, "1792x1024": 0.08, "1024x1792": 0.08 },
 * };
 */
export type ImageModelPricing = {
  /** USD per 1M input (prompt) tokens — token-metered models only. */
  input?: number;
  /** USD per 1M output (image) tokens — token-metered models only. */
  output?: number;
  /** Flat USD per generated image — per-image-metered models. */
  perImage?: number;
  /**
   * Per-size USD-per-image overrides, keyed by the requested `size`
   * label (e.g. `"1024x1024"`). When the resolved request size is a key
   * here, it wins over the flat `perImage`. Lets one model price its
   * size tiers (DALL·E 3 HD/large sizes cost more) without a second
   * model instance.
   */
  perImageBySize?: Record<string, number>;
};

/**
 * One generated image, normalized to a discriminated shape so callers
 * never have to probe which field a provider populated.
 *
 * - `{ type: "url" }` — a remote URL the provider hosts (DALL·E with
 *   `response_format: "url"`); URLs are typically short-lived, so
 *   download promptly if you need to persist the bytes.
 * - `{ type: "base64" }` — inlined base64 bytes with an explicit IANA
 *   `mediaType` (the GPT-image family and Imagen always return bytes).
 *
 * `revisedPrompt` carries the provider's rewritten prompt when prompt
 * enhancement ran (OpenAI `revised_prompt`, Imagen `enhancedPrompt`).
 */
export type GeneratedImage =
  | { type: "url"; url: string; mediaType?: string; revisedPrompt?: string }
  | { type: "base64"; base64: string; mediaType: string; revisedPrompt?: string };

/**
 * Options for a single {@link ImageModelContract.generate} request.
 * Every field is optional and provider-neutral; each adapter maps the
 * ones its API supports and ignores the rest. Provider-specific knobs
 * ride the index signature.
 */
export type ImageGenerationOptions = {
  /** How many images to generate. Adapters clamp to the provider's max. */
  count?: number;
  /**
   * Requested pixel size as `"WxH"` (e.g. `"1024x1024"`). Forwarded to
   * the provider's size param AND used to resolve `perImageBySize`
   * pricing. Mutually-informative with `aspectRatio` — pass whichever
   * the target provider speaks (OpenAI = size, Imagen = aspectRatio).
   */
  size?: string;
  /** Quality tier (e.g. `"standard"` / `"hd"` / `"low"` / `"high"`). */
  quality?: string;
  /** Aspect ratio (e.g. `"1:1"`, `"16:9"`) — ratio-based providers (Imagen). */
  aspectRatio?: string;
  /** Concepts to steer the image away from (Imagen `negativePrompt`). */
  negativePrompt?: string;
  /** Output container hint (`"png"` / `"jpeg"` / `"webp"`). */
  format?: string;
  /** Cancellation handle wired into the provider request where supported. */
  signal?: AbortSignal;
  /** Provider-specific escape hatch — forwarded verbatim. */
  [key: string]: unknown;
};

/**
 * Raw result of an {@link ImageModelContract.generate} call. Low-level,
 * like `EmbedderContract.embed` — it returns the images plus token
 * `Usage` (zeroed for per-image-metered providers) and THROWS a typed
 * `AIError` on failure. The never-throws `{ data, error, usage, report }`
 * envelope is added one layer up by the `ai.image()` facade verb.
 */
export type ImageGenerationResponse = {
  images: GeneratedImage[];
  /**
   * Token usage when the provider meters per token (gpt-image-1);
   * `{ input: 0, output: 0, total: 0 }` for per-image-metered providers
   * (DALL·E, Imagen), whose spend is priced from the image count via
   * {@link ImageModelPricing.perImage}.
   */
  usage: Usage;
};

/**
 * Provider-neutral contract for an image-generation model — the output
 * counterpart to {@link EmbedderContract}. Produced by an adapter's
 * optional `image?(config)` factory and handed to the `ai.image()`
 * facade verb, which wraps `generate()` into the uniform result
 * envelope, prices it, builds the report, and routes it to observers.
 *
 * @example
 * const model = openai.image({ name: "gpt-image-1" });
 * const { images, usage } = await model.generate("a red bicycle on a white background");
 */
export interface ImageModelContract {
  /** Image model identifier (e.g. `"gpt-image-1"`, `"imagen-4.0-generate-001"`). */
  readonly name: string;
  /** Provider this model belongs to (e.g. `"openai"`, `"google"`). */
  readonly provider: string;
  /**
   * Per-million-token OR per-image USD pricing. When set, `ai.image()`
   * computes `Usage.cost` at emit time so image spend rolls up through
   * the same report tree as text spend. Resolution mirrors the chat
   * models: per-model `pricing` > SDK registry > undefined.
   */
  readonly pricing?: ImageModelPricing;

  /**
   * Generate one or more images from a text prompt. Returns the
   * normalized images plus usage, or throws a typed `AIError` (auth,
   * rate-limit, content-filter, invalid-request) — caught and surfaced
   * on `result.error` by the `ai.image()` facade.
   */
  generate(prompt: string, options?: ImageGenerationOptions): Promise<ImageGenerationResponse>;
}

/**
 * Configuration passed to an adapter's `image()` factory. Mirrors
 * {@link EmbedderConfig}: `name` plus an optional per-model `pricing`
 * override and provider-specific keys on the index signature.
 *
 * @example
 * openai.image({ name: "dall-e-3", pricing: { perImage: 0.04 } });
 */
export type ImageModelConfig = {
  name: string;
  /** Per-model USD pricing override; wins over the SDK-level registry. */
  pricing?: ImageModelPricing;
  [key: string]: unknown;
};
