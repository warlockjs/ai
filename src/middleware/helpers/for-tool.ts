import type { AgentMiddleware } from "../../contracts/middleware";

/**
 * Scope a middleware's `tool`-level hooks to only fire for a
 * specific tool name (or a set of names). `execute` and `trip`
 * hooks pass through unchanged.
 *
 * **Role.** Tool-specific concerns — "rate-limit `search_web`",
 * "cache results for `fetch_faq`" — are common. Rather than adding
 * a `middleware` field to `ai.tool()` (see decisions §27), the
 * framework keeps one contract (`AgentMiddleware`) and offers this
 * helper for the locality problem. The middleware body stays agnostic
 * of the tool name; `forTool` handles the filtering.
 *
 * **What gets filtered.** Only `tool.before` / `tool.after` /
 * `tool.onError`. Each hook is wrapped so that `ctx.tool.name`
 * must be in the allowed set or the wrapped hook is a no-op.
 * `execute` and `trip` hooks are NOT touched — they run normally.
 *
 * **Why not filter execute/trip too?** Because a middleware that
 * reaches across levels (a tool-specific budget that initializes a
 * counter in `execute.before` and checks it in `tool.before`) still
 * needs `execute.before` to fire unconditionally. Scoping all hooks
 * would break cross-level middleware; scoping only `tool` hooks
 * matches the mental model of "this middleware cares about these
 * tools."
 *
 * **Single-name vs multi-name.** A string matches one tool; a string
 * array matches any of the listed tools. No wildcards, no regex —
 * keep it boring.
 *
 * @example
 * // Single tool
 * const scoped = ai.middleware.forTool(
 *   "search_web",
 *   toolRateLimit({ maxCalls: 3 }),
 * );
 *
 * @example
 * // Multiple tools sharing a rule
 * const scoped = ai.middleware.forTool(
 *   ["paid_api", "expensive_db"],
 *   toolRateLimit({ maxCalls: 5 }),
 * );
 *
 * ai.agent({
 *   model,
 *   tools: [webTool, paidApiTool, expensiveDbTool],
 *   middleware: [scoped],
 * });
 */
export function forTool(
  toolNames: string | ReadonlyArray<string>,
  middleware: AgentMiddleware,
): AgentMiddleware {
  const allowed = new Set(
    typeof toolNames === "string" ? [toolNames] : toolNames,
  );
  const scope =
    allowed.size === 1 ? Array.from(allowed)[0] : Array.from(allowed).join("+");

  if (!middleware.tool) {
    return middleware;
  }

  const innerBefore = middleware.tool.before;
  const innerAfter = middleware.tool.after;
  const innerOnError = middleware.tool.onError;

  return {
    ...middleware,
    name: `${middleware.name}[for:${scope}]`,
    tool: {
      before: innerBefore
        ? async ctx => {
            if (!allowed.has(ctx.tool.name)) {
              return;
            }

            return innerBefore(ctx);
          }
        : undefined,
      after: innerAfter
        ? async (ctx, result) => {
            if (!allowed.has(ctx.tool.name)) {
              return;
            }

            return innerAfter(ctx, result);
          }
        : undefined,
      onError: innerOnError
        ? async (ctx, error) => {
            if (!allowed.has(ctx.tool.name)) {
              return;
            }

            return innerOnError(ctx, error);
          }
        : undefined,
    },
  };
}
