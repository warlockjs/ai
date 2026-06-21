/**
 * Per-execution shared-state bag threaded through every middleware
 * hook of every level (`execute`, `trip`, `tool`) for a single
 * `agent.execute()` call.
 *
 * **Role.** Lets a single middleware accumulate state across hooks
 * and across levels without relying on closure capture (which would
 * leak between concurrent `execute()` calls on the same agent). Each
 * middleware namespaces its reads/writes by its own `name` — the
 * pipeline never inspects values.
 *
 * A fresh `Map` is constructed at `execute.before`-time and the same
 * reference flows through every nested `trip` and `tool` hook, then
 * is discarded at `execute.after` / `execute.onError`. Two concurrent
 * executions of the same agent therefore get isolated bags.
 *
 * @example
 * // Inside a budget middleware:
 * execute: {
 *   before(ctx) { ctx.state.set("budget.tokensUsed", 0); },
 * },
 * trip: {
 *   after(ctx, response) {
 *     const used = (ctx.state.get("budget.tokensUsed") as number) + response.usage.total;
 *     ctx.state.set("budget.tokensUsed", used);
 *     if (used > max) throw new BudgetExceededError(...);
 *   },
 * },
 */
export type MiddlewareState = Map<string, unknown>;
