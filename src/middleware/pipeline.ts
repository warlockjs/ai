import type { Logger } from "@warlock.js/logger";
import type {
  AgentMiddleware,
  MiddlewareExecuteContext,
  MiddlewareSupervisorContext,
  MiddlewareToolContext,
  MiddlewareTripContext,
} from "../contracts/middleware";

const LOG_MODULE = "ai.middleware";

/**
 * The four levels at which middleware can hook — mirrors
 * `AgentMiddleware`'s optional `execute` / `trip` / `tool` /
 * `supervisor` keys. Kept as a single named union so callers can pass
 * it around without inline-duplicating the literals. The first three
 * fire on the agent pipeline; `supervisor` fires once around a whole
 * `supervisor.execute()` run.
 */
export type MiddlewareLevel = "execute" | "trip" | "tool" | "supervisor";

/**
 * Shape of the context object for each level. The pipeline is
 * level-parameterized on the ctx type via this mapping so callers
 * get compile-time narrowing when they instantiate `runPipeline`.
 */
export type MiddlewareContextByLevel = {
  execute: MiddlewareExecuteContext;
  trip: MiddlewareTripContext;
  tool: MiddlewareToolContext;
  supervisor: MiddlewareSupervisorContext;
};

/**
 * Run an inner async operation through a stack of agent middlewares
 * at a single level, applying the onion-model before/after/onError
 * semantics documented on `AgentMiddleware`.
 *
 * **Semantics.**
 * - `before` hooks run in registration order (top-down).
 *   Returning a defined value from a `before` hook short-circuits the
 *   pipeline with that value as the result, skipping `inner()` and
 *   all deeper `before` / `after` hooks — but outer middleware
 *   `after` hooks (registered earlier) still run on the synthetic
 *   value.
 * - `after` hooks run in reverse registration order (bottom-up).
 *   Returning a defined value replaces the result before it
 *   propagates further out. Returning `void` / `undefined` keeps the
 *   existing result.
 * - `onError` hooks also run in reverse (bottom-up) — any error
 *   thrown by `inner()`, by a `before` hook, or by an `after` hook
 *   unwinds through each frame's `onError` in turn. Returning a
 *   defined value from `onError` recovers: the error is cleared and
 *   the returned value becomes the new result (which then flows
 *   through outer `after` hooks). Returning `void` propagates the
 *   error to the next outer frame.
 *
 * **Implementation.** Built by folding the middleware array from the
 * end inward: each middleware produces a closure that wraps the
 * previous closure (the deeper pipeline). The outermost wrap is
 * middleware index 0 — so registration order matches onion order
 * without any reverse iteration at call time.
 *
 * **No magic.** The pipeline does not swallow, retry, or translate
 * errors. Hooks that throw propagate unchanged (subject to `onError`
 * recovery). Pipeline-level logging is debug-only and respects each
 * middleware's `log: false` kill-switch.
 *
 * @example
 * const response = await runPipeline(
 *   middlewares,
 *   "trip",
 *   tripContext,
 *   () => model.complete(messages, callOptions),
 *   logger,
 * );
 */
export async function runPipeline<Level extends MiddlewareLevel, TResult>(
  middlewares: ReadonlyArray<AgentMiddleware>,
  level: Level,
  context: MiddlewareContextByLevel[Level],
  inner: () => Promise<TResult>,
  logger?: Logger,
): Promise<TResult> {
  if (middlewares.length === 0) {
    return inner();
  }

  let next: () => Promise<TResult> = inner;

  for (let index = middlewares.length - 1; index >= 0; index--) {
    const middleware = middlewares[index];
    const hooks = middleware[level];

    if (!hooks) {
      continue;
    }

    const previous = next;

    next = async () => {
      const logEnabled = middleware.log !== false && logger !== undefined;

      if (hooks.before) {
        if (logEnabled) {
          logger!.debug(LOG_MODULE, `${level}.before`, middleware.name, {
            middleware: middleware.name,
            level,
          });
        }

        const shortCircuit = await (
          hooks.before as (ctx: unknown) => Promise<unknown> | unknown
        )(context);

        if (shortCircuit !== undefined) {
          if (logEnabled) {
            logger!.debug(
              LOG_MODULE,
              `${level}.short-circuit`,
              middleware.name,
              {
                middleware: middleware.name,
                level,
              },
            );
          }

          return shortCircuit as TResult;
        }
      }

      let result: TResult;

      try {
        result = await previous();
      } catch (thrown) {
        if (!hooks.onError) {
          throw thrown;
        }

        const recovered = await (
          hooks.onError as (
            ctx: unknown,
            error: unknown,
          ) => Promise<unknown> | unknown
        )(context, thrown);

        if (recovered === undefined) {
          throw thrown;
        }

        if (logEnabled) {
          logger!.debug(LOG_MODULE, `${level}.recovered`, middleware.name, {
            middleware: middleware.name,
            level,
          });
        }

        result = recovered as TResult;
      }

      if (hooks.after) {
        const replacement = await (
          hooks.after as (
            ctx: unknown,
            value: unknown,
          ) => Promise<unknown> | unknown
        )(context, result);

        if (replacement !== undefined) {
          result = replacement as TResult;
        }

        if (logEnabled) {
          logger!.debug(LOG_MODULE, `${level}.after`, middleware.name, {
            middleware: middleware.name,
            level,
          });
        }
      }

      return result;
    };
  }

  return next();
}
