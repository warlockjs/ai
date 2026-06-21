import type { MiddlewareState } from "../../contracts/middleware";

/**
 * Typed accessor over `ctx.state` for a single namespace key. Wraps
 * the raw `Map<string, unknown>` so middleware authors stop typing
 * `as Counters | undefined` on every read.
 *
 * **Role.** Every built-in middleware reads and writes one or two
 * entries in `ctx.state` under its own name. Without a helper,
 * every call-site looks like:
 *
 * ```ts
 * const counters = context.state.get("budget.counters") as Counters | undefined;
 * if (!counters) { ... }
 * counters.tokens += n;
 * ```
 *
 * — cast noise, no type narrowing on `set`, no protection against
 * key typos. `namespacedState<T>` eliminates all three.
 *
 * **Scope.** Deliberately narrow: one key, typed value, four methods
 * (`get` / `set` / `delete` / `has`). Does NOT try to model compound
 * or nested keys — if you need those, use the raw `ctx.state` Map
 * directly, or create a second namespaced accessor for the second key.
 *
 * **Namespace convention.** Use the middleware's `name` as the key
 * (or a `name.<field>` prefix when a middleware needs multiple
 * entries). The pipeline does not enforce this — it is a convention
 * the built-ins follow to avoid collisions between middlewares.
 *
 * @example
 * // Inside a budget middleware:
 * const counters = namespacedState<Counters>(ctx, "budget");
 *
 * if (!counters.has()) {
 *   counters.set({ tokens: 0, costUSD: 0 });
 * }
 *
 * const current = counters.get()!;
 * current.tokens += response.usage.total;
 */
export function namespacedState<T>(
  ctx: { readonly state: MiddlewareState },
  namespace: string,
): NamespacedStateAccessor<T> {
  return {
    get(): T | undefined {
      return ctx.state.get(namespace) as T | undefined;
    },
    set(value: T): void {
      ctx.state.set(namespace, value);
    },
    delete(): void {
      ctx.state.delete(namespace);
    },
    has(): boolean {
      return ctx.state.has(namespace);
    },
  };
}

/**
 * Four-method accessor returned by `namespacedState`. Callers hold
 * it for the lifetime of a hook body — it is a thin typed view over
 * `ctx.state`, not a detached snapshot. Reads are live; writes hit
 * the underlying Map immediately and are visible to every other
 * hook that uses the same namespace.
 */
export type NamespacedStateAccessor<T> = {
  get(): T | undefined;
  set(value: T): void;
  delete(): void;
  has(): boolean;
};
