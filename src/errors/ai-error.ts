import type { ErrorCategory } from "./error-category.type";
import type { AIErrorCode } from "./error-code.type";

/**
 * Optional constructor payload shared by every `AIError` subclass.
 *
 * `cause` carries the original thrown value (SDK error, runtime crash,
 * validation failure) so downstream logging and debuggers can still
 * reach it. `context` is a free-form diagnostic bag for provider-raw
 * metadata (status codes, request ids, response headers) that shouldn't
 * be promoted to typed fields but is useful in logs and telemetry.
 *
 * **No `category` here.** Category is fixed per subclass via the
 * class-level `static defaultCategory`. Subclasses ARE their
 * category — `RateLimitError` is always `"rate-limit"`, never
 * something else at runtime. Direct `new AIError(...)` callers (the
 * one legitimate override case, since the base catch-all has no
 * specific class) receive a separate 4th constructor argument
 * instead, so the override is structurally unreachable from subclass
 * call sites.
 */
export type AIErrorOptions = {
  cause?: unknown;
  context?: Record<string, unknown>;
};

/**
 * Base class for every error thrown (or surfaced via `result.error`) by
 * `@warlock.js/ai` and its provider adapter packages.
 *
 * **Role.** The single typed error contract across the AI framework.
 * Every thrown error anywhere in `@warlock.js/ai*` is either an
 * `AIError` itself or one of its subclasses — plain `Error` must never
 * leak out. Consumers branch either on the narrow `error.code` (stable
 * string), on `error.category` (coarse dashboard grouping), or on
 * `instanceof` a specific subclass.
 *
 * **Independence.** Deliberately extends the platform `Error` directly
 * — never `HttpError` from `@warlock.js/core`. The AI framework is a
 * standalone product; coupling its error base to a web framework would
 * force every consumer to pull in the HTTP layer even when they only
 * use AI in a CLI, worker, or test.
 *
 * **Fields.**
 * - `code` — stable machine-readable identifier (see `AIErrorCode`).
 * - `category` — coarse `ErrorCategory` for dashboards / retry policy.
 *   Resolved at construction from the subclass's `static defaultCategory`
 *   (or, for direct `new AIError(...)` calls, from the explicit 4th
 *   constructor argument).
 * - `cause` — optional original thrown value (SDK error, nested error,
 *   raw value). Preserves root cause through re-wrapping.
 * - `context` — optional free-form diagnostic bag (status, requestId,
 *   headers). Consumers treat it as opaque; logs and telemetry read it.
 *
 * **Category override — direct AIError usage only.** Subclasses ARE
 * their category by type; there's no legitimate runtime override at
 * the subclass level. The 4th constructor argument exists ONLY for
 * direct `new AIError(...)` callers, who would otherwise be stuck with
 * the `"unknown"` default. Subclasses construct via `super(code,
 * message, options)` and physically cannot reach the override slot
 * through their own typed signatures.
 *
 * @example
 * try {
 *   await agent.execute("hello");
 * } catch (error) {
 *   if (error instanceof AIError) {
 *     console.error(`[${error.code}] (${error.category}) ${error.message}`);
 *   }
 * }
 *
 * @example
 * // Direct AIError construction with explicit category — escape hatch
 * // for call sites that lack a specific subclass.
 * throw new AIError("UNEXPECTED", "transient glitch", undefined, "provider");
 */
export class AIError extends Error {
  /**
   * Class-level category for every instance of this error type.
   * Subclasses redeclare with their own concrete `ErrorCategory` so
   * `error.category` is correct without per-call wiring. The base
   * class keeps `"unknown"` so untyped direct throws of `AIError`
   * itself remain honest about their lack of dispatch information
   * (and can override via the 4th constructor argument).
   */
  public static readonly defaultCategory: ErrorCategory = "unknown";

  public readonly code: AIErrorCode;
  public readonly category: ErrorCategory;
  public readonly context?: Record<string, unknown>;

  public constructor(
    code: AIErrorCode,
    message: string,
    options?: AIErrorOptions,
    category?: ErrorCategory,
  ) {
    super(message);

    this.name = "AIError";
    this.code = code;
    this.context = options?.context;
    this.category = category ?? (this.constructor as typeof AIError).defaultCategory;

    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}
