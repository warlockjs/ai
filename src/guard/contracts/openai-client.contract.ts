/**
 * Minimal structural view of the part of the `openai` SDK the
 * `moderation` detector actually calls. Declared locally (rather than
 * importing the SDK's own types) so `@warlock.js/ai` type-checks even
 * when `openai` is **not** installed — it is an OPTIONAL peer, lazily
 * imported at runtime. The shape tracks the OpenAI Node SDK v4:
 * `client.moderations.create({ model, input })` resolves to a response whose
 * `results[]` each carry a `flagged` boolean and per-category `categories` /
 * `category_scores` maps.
 *
 * Surfacing it as a contract lets a caller pass a ready
 * {@link OpenAiClientLike} (real `OpenAI` instance, mock, or proxy) on
 * `OpenAiModerationOptions.client` to bypass the lazy import entirely.
 */

/**
 * A pre-built OpenAI-compatible client — any object exposing
 * `moderations.create`. Passing one on `OpenAiModerationOptions.client` lets
 * the detector skip the lazy `import("openai")` entirely (so bring-your-own-
 * client callers and hermetic tests never need the SDK on disk).
 */
export interface OpenAiClientLike {
  readonly moderations: {
    create(body: OpenAiModerationCreateBody): Promise<OpenAiModerationResponse>;
  };
}

/** Subset of the moderation-create body the detector populates. */
export interface OpenAiModerationCreateBody {
  /** Moderation model id (e.g. `"omni-moderation-latest"`). */
  readonly model: string;
  /** The text to moderate. */
  readonly input: string;
}

/** Subset of the moderation response the detector reads. */
export interface OpenAiModerationResponse {
  readonly results: readonly OpenAiModerationResult[];
}

/**
 * One moderation result. `flagged` is the SDK's overall verdict; `categories`
 * maps each policy category to whether it tripped; `category_scores` carries
 * the per-category confidence, surfaced on each {@link GuardrailMatch.label}'s
 * companion data when present.
 */
export interface OpenAiModerationResult {
  readonly flagged: boolean;
  readonly categories: Record<string, boolean>;
  readonly category_scores?: Record<string, number>;
}
