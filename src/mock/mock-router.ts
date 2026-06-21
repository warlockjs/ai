import { END } from "../contracts/end.type";
import type { Next } from "../contracts/supervisor/next.type";
import type { RouteContext } from "../contracts/supervisor/route-context.type";

/**
 * A canned routing decision for {@link mockRouter}. Either a literal
 * {@link Next} value (intent key, fan-out array, or the `END`
 * sentinel) or a predicate that derives the decision from the live
 * {@link RouteContext} — the latter lets a test branch on accumulated
 * state without scripting an exact per-iteration sequence.
 */
export type MockRouterDecision<TState = Record<string, unknown>> =
  | Next
  | ((context: RouteContext<TState>) => Next);

/**
 * Behavior when the canned decision queue is exhausted before the
 * supervisor terminates on its own.
 *
 * - `"end"` (default) — return `END`, terminating the run cleanly. The
 *   common case: script the interesting turns, let the run stop.
 * - `"throw"` — throw, surfacing the over-run as a test failure. Use
 *   when every iteration must be accounted for.
 * - `"repeat"` — replay the last decision for every further iteration.
 *   Useful for "keep routing to the same intent until evaluate is
 *   satisfied" scenarios.
 */
export type MockRouterExhaustion = "end" | "throw" | "repeat";

/**
 * Options for {@link mockRouter}.
 */
export type MockRouterOptions = {
  /** What to do once the decision queue is exhausted. Default `"end"`. */
  onExhausted?: MockRouterExhaustion;
};

/**
 * Build a deterministic `route` callback that replays a canned
 * sequence of routing decisions — one per supervisor iteration — for
 * testing supervisors without an LLM router.
 *
 * Drop the returned callback into `ai.supervisor({ route: mockRouter([...]) })`
 * in place of an LLM `router`. The Nth iteration consumes the Nth
 * decision; a function decision is evaluated against the live
 * `RouteContext`. When the queue runs out, behavior follows
 * `options.onExhausted` (default: terminate with `END`).
 *
 * Pairs with the `toRouteTo` / `toConverge` matchers to assert the
 * resulting report tree.
 *
 * @example
 * const supervisor = ai.supervisor({
 *   name: "draft-then-review",
 *   intents: { writer, critic },
 *   route: mockRouter(["writer", "critic", END]),
 * });
 *
 * @example
 * // Branch on accumulated state, repeat the last decision until done.
 * route: mockRouter(
 *   ["research", (ctx) => (ctx.state.summary ? END : "research")],
 *   { onExhausted: "repeat" },
 * );
 */
export function mockRouter<TState = Record<string, unknown>>(
  decisions: MockRouterDecision<TState>[],
  options: MockRouterOptions = {},
): (context: RouteContext<TState>) => Next {
  const onExhausted = options.onExhausted ?? "end";
  let cursor = 0;

  return (context: RouteContext<TState>): Next => {
    if (cursor < decisions.length) {
      const decision = decisions[cursor];
      cursor++;

      return resolveDecision(decision, context);
    }

    if (onExhausted === "throw") {
      throw new Error(
        `mockRouter exhausted after ${decisions.length} decision(s) at iteration ${context.iteration}`,
      );
    }

    if (onExhausted === "repeat" && decisions.length > 0) {
      return resolveDecision(decisions[decisions.length - 1], context);
    }

    return END;
  };
}

/**
 * Resolve a single decision entry into a concrete {@link Next} —
 * invoking the predicate form against the live context, or returning
 * the literal form verbatim.
 */
function resolveDecision<TState>(
  decision: MockRouterDecision<TState>,
  context: RouteContext<TState>,
): Next {
  if (typeof decision === "function") {
    return decision(context);
  }

  return decision;
}
