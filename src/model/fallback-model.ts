import type {
  FallbackAttempt,
  FallbackModelContract,
  FallbackModelOptions,
  FallbackRetryPredicate,
} from "../contracts/fallback-model.contract";
import type { Message } from "../contracts/conversation-message.type";
import type {
  ModelCallOptions,
  ModelCapabilities,
  ModelContract,
  ModelResponse,
  ModelStreamChunk,
} from "../contracts/model.contract";
import type { Usage } from "../contracts/result/usage.type";
import { AIError } from "../errors/ai-error";
import type { AIErrorCode } from "../errors/error-code.type";
import { accumulateCost } from "../utils/compute-cost";

/**
 * Error codes treated as transient — and therefore worth falling over
 * to the next model — when the caller does not supply an explicit
 * `retryOn`. Covers provider rate-limits, timeouts, and the generic
 * `PROVIDER_ERROR` catch-all that adapters throw for 5xx / unknown
 * network failures. Deliberately omits auth, invalid-request,
 * context-length, and content-filter: those fail identically on every
 * downstream model, so retrying only burns budget.
 */
const DEFAULT_RETRYABLE_CODES: readonly AIErrorCode[] = [
  "PROVIDER_RATE_LIMIT",
  "PROVIDER_TIMEOUT",
  "PROVIDER_ERROR",
];

/**
 * A `ModelContract` that wraps an ordered list of models and tries each
 * in turn, advancing to the next only when the current one fails with a
 * matching (transient) provider error.
 *
 * **Role.** A drop-in `ModelContract` for resilience: hand it to any
 * agent / workflow / supervisor in place of a single model and provider
 * outages, rate-limits, and timeouts transparently fail over to a
 * backup. Non-transient failures (bad key, oversized prompt, blocked
 * content) re-throw immediately rather than wastefully retrying.
 *
 * **What it owns / doesn't own.** Owns the ordered model list, the
 * retry decision, and per-call usage aggregation across attempted
 * models. Does NOT own retry/backoff timing (it advances instantly to
 * the next model — pair it with a backoff middleware if you want delay)
 * nor any provider I/O of its own; every call is delegated to a wrapped
 * model.
 *
 * **Streaming fall-over caveat.** `stream()` can only fail over while no
 * chunk has been emitted yet. Once the first `delta` / `tool-call`
 * reaches the consumer, the partial output cannot be un-sent, so a
 * mid-stream failure propagates instead of restarting on the next
 * model.
 *
 * @example
 * const model = fallbackModel([
 *   ai.openai.model({ name: "gpt-4o" }),
 *   ai.anthropic.model({ name: "claude-3-5-sonnet" }),
 * ]);
 * const agent = ai.agent({ model });
 *
 * @example
 * // custom retry predicate
 * const model = fallbackModel([primary, backup], {
 *   retryOn: (error) => error instanceof ProviderError,
 * });
 */
export function fallbackModel(
  models: ModelContract[],
  options?: FallbackModelOptions,
): FallbackModelContract {
  if (models.length === 0) {
    throw new AIError(
      "PROVIDER_INVALID_REQUEST",
      "fallbackModel() requires at least one model in the chain.",
      undefined,
      "validation",
    );
  }

  return new FallbackModel(models, resolveShouldRetry(options?.retryOn));
}

/**
 * Build the chain-advancement predicate from the caller's `retryOn`.
 * An array becomes a code membership test against an `AIError.code`; a
 * function is used verbatim; absence falls back to the transient
 * default set.
 */
function resolveShouldRetry(
  retryOn: FallbackModelOptions["retryOn"],
): FallbackRetryPredicate {
  if (typeof retryOn === "function") {
    return retryOn;
  }

  const codes: readonly AIErrorCode[] = retryOn ?? DEFAULT_RETRYABLE_CODES;

  return (error: unknown): boolean => {
    return error instanceof AIError && codes.includes(error.code);
  };
}

/**
 * Add a successful call's usage into a running aggregate, mirroring the
 * agent's trip accumulation: scalar token counts sum, optional channels
 * sum only when present, and cost merges via `accumulateCost` so an
 * unpriced model never erases a priced sibling's cost.
 */
function aggregateUsage(total: Usage, next: Usage): void {
  total.input += next.input;
  total.output += next.output;
  total.total += next.total;

  if (next.cachedTokens !== undefined) {
    total.cachedTokens = (total.cachedTokens ?? 0) + next.cachedTokens;
  }

  if (next.reasoningTokens !== undefined) {
    total.reasoningTokens = (total.reasoningTokens ?? 0) + next.reasoningTokens;
  }

  if (next.cacheWriteTokens !== undefined) {
    total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + next.cacheWriteTokens;
  }

  total.cost = accumulateCost(total.cost, next.cost);
}

/**
 * Internal `ModelContract` implementation backing {@link fallbackModel}.
 *
 * Long-lived (its identity, capabilities, and pricing front the primary
 * model for the wrapper's whole lifetime) so it is a class rather than a
 * closure. Per-call mutable state (the usage aggregate, the attempt log)
 * lives in {@link FallbackRun}, instantiated fresh on every
 * `complete()` / `stream()` so concurrent calls never share bookkeeping.
 */
class FallbackModel implements FallbackModelContract {
  public readonly name: string;
  public readonly provider: string;
  public readonly capabilities?: ModelCapabilities;
  public readonly pricing?: ModelContract["pricing"];

  private latestAttempts: FallbackAttempt[] = [];

  public constructor(
    private readonly models: ModelContract[],
    private readonly shouldRetry: FallbackRetryPredicate,
  ) {
    const primary = models[0]!;

    this.name = primary.name;
    this.provider = primary.provider;
    this.capabilities = primary.capabilities;
    this.pricing = primary.pricing;
  }

  /**
   * Models that failed with a chain-advancing error during the most
   * recent `complete()` / `stream()` call, in attempt order. Empty when
   * the primary model succeeded outright. Overwritten on each call.
   */
  public get lastAttempts(): FallbackAttempt[] {
    return this.latestAttempts;
  }

  public async complete(
    messages: Message[],
    options?: ModelCallOptions,
  ): Promise<ModelResponse> {
    const run = new FallbackRun(this.models, this.shouldRetry);
    const response = await run.complete(messages, options);

    this.latestAttempts = run.attempts;

    return response;
  }

  public stream(
    messages: Message[],
    options?: ModelCallOptions,
  ): AsyncIterable<ModelStreamChunk> {
    const run = new FallbackRun(this.models, this.shouldRetry);

    return run.stream(messages, options, (attempts) => {
      this.latestAttempts = attempts;
    });
  }
}

/**
 * Per-call execution of the fallback chain. Holds the usage aggregate
 * and the attempt log for a single `complete()` / `stream()` invocation
 * so the long-lived {@link FallbackModel} stays free of shared mutable
 * state across concurrent calls.
 */
class FallbackRun {
  public readonly attempts: FallbackAttempt[] = [];

  private readonly usage: Usage = { input: 0, output: 0, total: 0 };

  public constructor(
    private readonly models: ModelContract[],
    private readonly shouldRetry: FallbackRetryPredicate,
  ) {}

  /**
   * Try each model's `complete()` in order. On a chain-advancing error,
   * record the attempt and move to the next; on the last model (or a
   * non-retryable error) re-throw the underlying error verbatim so the
   * caller still sees a typed `AIError` with its original code.
   */
  public async complete(
    messages: Message[],
    options?: ModelCallOptions,
  ): Promise<ModelResponse> {
    for (let index = 0; index < this.models.length; index++) {
      const model = this.models[index]!;
      const isLast = index === this.models.length - 1;

      try {
        const response = await model.complete(messages, options);

        aggregateUsage(this.usage, response.usage);

        return { ...response, usage: this.usage };
      } catch (error) {
        if (isLast || !this.shouldRetry(error)) {
          throw error;
        }

        this.recordAttempt(model, error);
      }
    }

    throw new AIError(
      "PROVIDER_ERROR",
      "fallbackModel() exhausted its chain without producing a response.",
      undefined,
      "provider",
    );
  }

  /**
   * Try each model's `stream()` in order. Fall-over is only attempted
   * while no chunk has been emitted yet for the current model — once the
   * consumer has seen a `delta` / `tool-call`, a mid-stream failure
   * propagates instead of restarting (partial output cannot be un-sent).
   * The aggregated usage replaces the `done` chunk's usage so the caller
   * sees the chain total.
   */
  public async *stream(
    messages: Message[],
    options: ModelCallOptions | undefined,
    onSettle: (attempts: FallbackAttempt[]) => void,
  ): AsyncIterable<ModelStreamChunk> {
    try {
      for (let index = 0; index < this.models.length; index++) {
        const model = this.models[index]!;
        const isLast = index === this.models.length - 1;
        let emitted = false;

        try {
          for await (const chunk of model.stream(messages, options)) {
            if (chunk.type === "done") {
              aggregateUsage(this.usage, chunk.usage);

              yield { ...chunk, usage: this.usage };
              return;
            }

            emitted = true;

            yield chunk;
          }

          return;
        } catch (error) {
          if (emitted || isLast || !this.shouldRetry(error)) {
            throw error;
          }

          this.recordAttempt(model, error);
        }
      }

      throw new AIError(
        "PROVIDER_ERROR",
        "fallbackModel() exhausted its chain without producing a response.",
        undefined,
        "provider",
      );
    } finally {
      onSettle(this.attempts);
    }
  }

  private recordAttempt(model: ModelContract, error: unknown): void {
    this.attempts.push({
      modelName: model.name,
      provider: model.provider,
      error,
    });
  }
}
