import type {
  AgentMiddleware,
  MiddlewareExecuteContext,
} from "../../contracts/middleware";
import { BudgetExceededError, type BudgetUnit } from "../../errors";
import { namespacedState } from "../utils";
import type {
  BudgetContract,
  BudgetContractDimension,
  BudgetContractViolation,
} from "./budget-contract.type";

export type {
  BudgetContract,
  BudgetContractDimension,
  BudgetContractFallback,
  BudgetContractViolation,
  BudgetContractViolationMode,
} from "./budget-contract.type";

/**
 * Per-model pricing used to compute USD cost from token counts.
 * Caller-supplied — no bundled table. Keys are model names (the
 * `ModelContract.name` value); values are input / output token
 * prices expressed as **USD per 1K tokens** to match every major
 * provider's published pricing sheet.
 */
export type BudgetPricing = Record<
  string,
  {
    /** USD per 1,000 input tokens. */
    inputPer1K: number;
    /** USD per 1,000 output tokens. */
    outputPer1K: number;
  }
>;

/**
 * Configuration for `budget()`. At least one of `maxTokens` or
 * `maxCostUSD` must be supplied — a budget with no cap is a no-op.
 */
export type BudgetOptions = {
  /**
   * Hard cap on cumulative total tokens (input + output, summed
   * across every trip of the run). Inclusive — exceeding triggers
   * the configured `onExceeded`.
   */
  maxTokens?: number;
  /**
   * Hard cap on cumulative USD cost. Requires `pricing` for the
   * agent's configured model — without a pricing entry the USD check
   * silently skips (tokens-only enforcement still applies).
   */
  maxCostUSD?: number;
  /**
   * Per-model pricing table used to compute USD cost. Only consulted
   * when `maxCostUSD` is set. Model names must match the running
   * agent's `ModelContract.name` exactly.
   */
  pricing?: BudgetPricing;
  /**
   * Behavior when a cap is breached. `"abort"` throws
   * `BudgetExceededError` — surfaces on `result.error`, stops the
   * run at the next trip boundary. `"warn"` logs a warning and
   * lets the run continue (useful for observability-first rollouts
   * before flipping the switch to abort). Default `"abort"`.
   */
  onExceeded?: "abort" | "warn";
  /**
   * Override the middleware name. Useful when two budgets coexist
   * (e.g. a per-request cap plus a session-wide cap via different
   * instances). Default `"budget"`.
   */
  name?: string;
  /**
   * Declarative SLO / cost contract enforced on top of (and
   * independently of) the legacy `maxTokens` / `maxCostUSD` caps.
   * Adds a wall-clock `maxLatencyMs` dimension and a per-contract
   * `onViolation` reaction (`"abort"` hard-stops, `"fallback"` records
   * a signal + fires `fallback` and lets the run continue). Omit to
   * keep the classic budget behavior unchanged.
   *
   * Read a recorded fallback signal back with
   * {@link readBudgetFallbackSignal}.
   */
  contract?: BudgetContract;
};

type BudgetCounters = {
  tokens: number;
  costUSD: number;
  warned: boolean;
  /**
   * Wall-clock epoch ms captured at `execute.before`. Used to derive
   * cumulative run latency for the contract's `maxLatencyMs` clause.
   */
  startedAt: number;
  /**
   * Set once a `"fallback"` contract clause has fired, so the signal +
   * callback are emitted at most once per run even if later trips keep
   * breaching.
   */
  fallbackFired: boolean;
};

/**
 * Recorded contract fallback signal, stashed under the `<name>.fallback`
 * state key when a `"fallback"` clause trips. A fallback orchestrator
 * reads it via {@link readBudgetFallbackSignal} to decide how to degrade.
 */
export type BudgetFallbackSignal = BudgetContractViolation;

/**
 * The `BudgetUnit` to stamp on the thrown error per contract dimension.
 * Latency has no native unit — it borrows `"requests"` as the least-wrong
 * operational measure, while the authoritative detail rides on the
 * error's `context.dimension`.
 */
const DIMENSION_UNIT: Record<BudgetContractDimension, BudgetUnit> = {
  tokens: "tokens",
  cost: "usd",
  latency: "requests",
};

function breach(
  limit: number,
  actual: number,
  unit: BudgetUnit,
  name: string,
): never {
  throw new BudgetExceededError(
    `budget "${name}" exceeded — ${actual} ${unit} (cap: ${limit})`,
    { limit, actual, unit },
  );
}

function breachContract(
  name: string,
  dimension: BudgetContractDimension,
  limit: number,
  actual: number,
): never {
  throw new BudgetExceededError(
    `budget "${name}" contract exceeded — ${dimension} ${actual} (cap: ${limit})`,
    {
      limit,
      actual,
      unit: DIMENSION_UNIT[dimension],
      context: { dimension, limit, actual, source: "contract" },
    },
  );
}

/**
 * Read the contract fallback signal recorded by a `budget()` middleware
 * running under `contract.onViolation: "fallback"`. Returns `undefined`
 * when no clause was breached.
 *
 * **Role.** The middleware cannot itself switch models on a soft breach,
 * so it records a typed {@link BudgetFallbackSignal} in the shared state
 * bag and lets the run continue. A fallback orchestrator (or the
 * `execute.after` hook of an outer middleware) reads it back here and
 * decides how to degrade the next run — cheaper model, cached answer,
 * truncated context.
 *
 * @param state - The middleware state bag (`ctx.state`).
 * @param name - The budget middleware's name. Default `"budget"`,
 *   matching `BudgetOptions.name`'s default.
 *
 * @example
 * const guard = budget({ contract: { maxCostUSD: 0.05, onViolation: "fallback" } });
 *
 * // In an outer middleware's execute.after, after the run:
 * const signal = readBudgetFallbackSignal(ctx.state);
 * if (signal?.dimension === "cost") {
 *   await rerunOnCheaperModel();
 * }
 */
export function readBudgetFallbackSignal(
  state: MiddlewareExecuteContext["state"],
  name = "budget",
): BudgetFallbackSignal | undefined {
  return namespacedState<BudgetFallbackSignal>(
    { state },
    `${name}.fallback`,
  ).get();
}

/**
 * Enforced token and / or USD budget for an agent run.
 *
 * **Role.** Guards against runaway tool loops, misconfigured
 * prompts, and unexpected provider price swings by capping
 * cumulative usage across every LLM trip of a single execution.
 * Aborts the run with a typed `BudgetExceededError` the moment a cap
 * is breached, rather than letting the damage grow trip by trip.
 *
 * **Scope.** Per-execution. A fresh counter is created at
 * `execute.before` and lives in the middleware state bag until the
 * run ends. Two concurrent `agent.execute()` calls on the same
 * agent therefore enforce the cap independently.
 *
 * **Token accounting.** After each successful trip, the middleware
 * adds `response.usage.total` to its running total and checks
 * against `maxTokens`. Synthetic trips (cache hits) contribute
 * `usage.total` as returned by the cache — cache middleware is
 * expected to surface zero usage on a hit, which naturally excludes
 * those trips from the budget.
 *
 * **USD accounting.** When `maxCostUSD` + `pricing[modelName]` are
 * both present, the middleware converts per-trip input / output
 * tokens to USD and accumulates. Missing pricing silently degrades
 * to tokens-only — explicit rather than guessing.
 *
 * **Warn mode.** `onExceeded: "warn"` logs a single warning the first
 * time a cap is breached and lets the run continue. Useful for
 * measuring real-world traffic against a proposed cap before flipping
 * to `"abort"` in production.
 *
 * **Contract / SLO mode.** Pass `contract` to enforce a declarative
 * service-level objective — `maxCostUSD`, `maxLatencyMs`, `maxTokens` —
 * on top of the legacy caps, with a single `onViolation` reaction:
 * `"abort"` hard-stops with `BudgetExceededError`; `"fallback"` records
 * a typed signal (read it via {@link readBudgetFallbackSignal}), fires
 * the optional `fallback` callback, and lets the run continue so an
 * outer layer can degrade gracefully. The contract's clauses are
 * evaluated independently of — and after — the top-level caps; the
 * top-level caps stay fully functional with or without a contract.
 *
 * @example
 * const budgetMiddleware = budget({ maxTokens: 50_000 });
 *
 * const myAgent = agent({
 *   model,
 *   middleware: [budgetMiddleware],
 * });
 *
 * @example
 * // With USD cap and custom pricing
 * const guard = budget({
 *   maxCostUSD: 0.5,
 *   pricing: {
 *     "gpt-4o": { inputPer1K: 0.005, outputPer1K: 0.015 },
 *   },
 * });
 *
 * @example
 * // SLO contract — soft-fallback on any breach
 * const sloGuard = budget({
 *   pricing: { "gpt-4o": { inputPer1K: 0.005, outputPer1K: 0.015 } },
 *   contract: {
 *     maxCostUSD: 0.05,
 *     maxLatencyMs: 8_000,
 *     maxTokens: 40_000,
 *     onViolation: "fallback",
 *     fallback: (violation) => routeToCheaperModel(violation.dimension),
 *   },
 * });
 */
export function budget(options: BudgetOptions): AgentMiddleware {
  const name = options.name ?? "budget";
  const onExceeded = options.onExceeded ?? "abort";
  const hasTokenCap = typeof options.maxTokens === "number";
  const hasCostCap = typeof options.maxCostUSD === "number";

  const contract = options.contract;
  const contractMode = contract?.onViolation ?? "abort";
  const hasContractTokenCap = typeof contract?.maxTokens === "number";
  const hasContractCostCap = typeof contract?.maxCostUSD === "number";
  const hasContractLatencyCap = typeof contract?.maxLatencyMs === "number";
  const contractNeedsCost = hasCostCap || hasContractCostCap;
  // Warn once per model when a cost cap is configured but the running model
  // has no pricing entry — without this the USD cap silently never enforces
  // (costUSD stays 0), a fail-open the JSDoc on `maxCostUSD` documents.
  const warnedUnpricedModels = new Set<string>();

  return {
    name,
    execute: {
      before(context) {
        const counters = namespacedState<BudgetCounters>(context, name);
        counters.set({
          tokens: 0,
          costUSD: 0,
          warned: false,
          startedAt: Date.now(),
          fallbackFired: false,
        });
      },
    },
    trip: {
      async after(context, response) {
        const counters = namespacedState<BudgetCounters>(context, name).get();

        if (!counters) {
          return;
        }

        counters.tokens += response.usage.total;

        if (contractNeedsCost) {
          const pricing = options.pricing?.[context.model.name];

          if (pricing) {
            const tripCost =
              (response.usage.input / 1000) * pricing.inputPer1K +
              (response.usage.output / 1000) * pricing.outputPer1K;
            counters.costUSD += tripCost;
          } else if (!warnedUnpricedModels.has(context.model.name)) {
            // A cost cap is set but no pricing matched the running model, so
            // costUSD can never grow and the USD cap silently never fires.
            // Surface the fail-open once per model instead of swallowing it.
            warnedUnpricedModels.add(context.model.name);
            console.warn(
              `ai.middleware.budget("${name}"): a USD cost cap is set but no pricing entry ` +
                `matches the running model "${context.model.name}" — the cap cannot be enforced ` +
                `for it. Add a pricing entry for "${context.model.name}" to options.pricing.`,
            );
          }
        }

        if (hasTokenCap && counters.tokens > options.maxTokens!) {
          if (onExceeded === "abort") {
            breach(options.maxTokens!, counters.tokens, "tokens", name);
          }

          if (!counters.warned) {
            counters.warned = true;
          }
        }

        if (hasCostCap && counters.costUSD > options.maxCostUSD!) {
          if (onExceeded === "abort") {
            breach(options.maxCostUSD!, counters.costUSD, "usd", name);
          }

          if (!counters.warned) {
            counters.warned = true;
          }
        }

        if (!contract) {
          return;
        }

        if (hasContractTokenCap && counters.tokens > contract.maxTokens!) {
          await enforceContract(
            context,
            counters,
            name,
            contractMode,
            contract,
            "tokens",
            contract.maxTokens!,
            counters.tokens,
          );
        }

        if (hasContractCostCap && counters.costUSD > contract.maxCostUSD!) {
          await enforceContract(
            context,
            counters,
            name,
            contractMode,
            contract,
            "cost",
            contract.maxCostUSD!,
            counters.costUSD,
          );
        }

        if (hasContractLatencyCap) {
          const elapsedMs = Date.now() - counters.startedAt;

          if (elapsedMs > contract.maxLatencyMs!) {
            await enforceContract(
              context,
              counters,
              name,
              contractMode,
              contract,
              "latency",
              contract.maxLatencyMs!,
              elapsedMs,
            );
          }
        }
      },
    },
  };
}

/**
 * Apply the contract's reaction to a single breached clause. `"abort"`
 * throws `BudgetExceededError` (stops the run); `"fallback"` records the
 * signal once, fires the callback, and returns so the run continues.
 *
 * The callback is invoked at most once per run (guarded by
 * `counters.fallbackFired`) and its rejections are swallowed — a buggy
 * fallback hook must never crash the agent.
 */
async function enforceContract(
  context: MiddlewareExecuteContext,
  counters: BudgetCounters,
  name: string,
  mode: NonNullable<BudgetContract["onViolation"]>,
  contract: BudgetContract,
  dimension: BudgetContractDimension,
  limit: number,
  actual: number,
): Promise<void> {
  if (mode === "abort") {
    breachContract(name, dimension, limit, actual);
  }

  if (counters.fallbackFired) {
    return;
  }

  counters.fallbackFired = true;

  const violation: BudgetContractViolation = {
    dimension,
    limit,
    actual,
    mode,
  };

  namespacedState<BudgetContractViolation>(context, `${name}.fallback`).set(
    violation,
  );

  if (!contract.fallback) {
    return;
  }

  try {
    await contract.fallback(violation, context);
  } catch {
    // A fallback callback is a notification hook — its failure must
    // never crash the run. Swallow deliberately.
  }
}
