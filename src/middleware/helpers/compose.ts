import type { AgentMiddleware } from "../../contracts/middleware";

/**
 * Flatten one or more middleware sources into a single ordered
 * array suitable for `agent({ middleware: [...] })`.
 *
 * **Role.** As middleware catalogs grow, agent configs accumulate
 * long arrays that mix "always-on" stacks (cache + budget + guardrail)
 * with per-concern extras (per-tool rate-limits, audit hooks). A
 * single `compose` call lets callers keep those sources as named
 * variables and flatten at the registration site.
 *
 * **Semantics.** Registration order is preserved across sources —
 * `compose(a, b, c)` produces `[...a, ...b, ...c]`. Because the
 * pipeline's onion is strictly registration-ordered, the flattened
 * order is the execution order. No de-duplication, no sorting, no
 * priority logic — that would hide bugs, not fix them.
 *
 * **Accepts arrays OR individual middlewares.** Both forms are
 * common in callsite code; the helper flattens either.
 *
 * @example
 * const standardStack = [
 *   ai.middleware.semanticCache({ ... }),
 *   ai.middleware.budget({ maxTokens: 20_000 }),
 *   ai.middleware.guardrail({ ... }),
 * ];
 *
 * const toolRateLimits = [
 *   toolRateLimit({ tool: "search_web", maxCalls: 3 }),
 *   toolRateLimit({ tool: "expensive_api", maxCalls: 1 }),
 * ];
 *
 * const myAgent = ai.agent({
 *   model,
 *   middleware: ai.middleware.compose(standardStack, toolRateLimits, auditMiddleware),
 * });
 */
export function composeMiddleware(
  ...sources: ReadonlyArray<AgentMiddleware | ReadonlyArray<AgentMiddleware>>
): AgentMiddleware[] {
  const out: AgentMiddleware[] = [];

  for (const source of sources) {
    if (Array.isArray(source)) {
      out.push(...source);
      continue;
    }

    out.push(source as AgentMiddleware);
  }

  return out;
}
