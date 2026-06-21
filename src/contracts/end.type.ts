/**
 * Framework-global termination sentinel. Emitted by any primitive
 * whose control flow is routed through JSON-serializable strings —
 * supervisor (router agent's `next`, deterministic `route` callback),
 * future planner (plan steps), future orchestrator (session
 * directive), any future primitive that needs to say "stop" across a
 * wire that can't carry `null`.
 *
 * **Why one shared literal.** Consumers learn one word. Cross-
 * primitive pipes — a planner feeding a supervisor, a supervisor
 * nested as a tool inside an orchestrator — can pass the sentinel
 * through without translation.
 *
 * **Why this specific string.** Brand-prefixed (`__warlock:`) so it
 * can't collide with a realistic user-chosen intent / step / route
 * key (`"end"`, `"done"`, `"stop"` are all valid user keys).
 * Underscore-surrounded so it stands out in logs and snapshots.
 * JSON-safe so a router agent emits it verbatim.
 *
 * **Not used by every primitive.** Workflow's `nextStep` returns
 * `null` to end — a callback-level mechanism that predates this
 * sentinel. Workflows keep `null`; the sentinel is for primitives
 * whose "end" must survive a JSON boundary.
 *
 * @example
 * import { END } from "@warlock.js/ai";
 *
 * // Supervisor route callback
 * ai.supervisor({
 *   intents: { writer, critic },
 *   route: (ctx) => (ctx.iteration >= 5 ? END : "writer"),
 * });
 *
 * // Router agent output schema
 * const router = ai.agent({
 *   model,
 *   output: z.object({
 *     next: z.union([z.string(), z.array(z.string()), z.literal(END)]),
 *   }),
 * });
 */
export const END = "__warlock:end__" as const;

/**
 * Value type of `END`. Exposed so consumers building Zod / Standard
 * Schema output schemas can write `z.literal(END)` without
 * hard-coding the string, and so generic helpers that accept "the
 * end sentinel" can type-narrow correctly.
 */
export type EndSentinel = typeof END;
