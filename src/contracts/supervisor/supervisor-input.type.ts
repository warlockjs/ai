/**
 * Accepted input shape for `supervisor.execute(input)` and the
 * matching field on every supervisor context (`RouteContext`,
 * `EvaluateContext`, `IterationSnapshot`).
 *
 * Two shapes carry every realistic case without bloating the factory
 * with a fourth generic:
 *
 * - `string` — raw user message, the most common case.
 * - `Record<string, unknown>` — structured payload (e.g. `{ orderId,
 *   reason, customerId }`) when the supervisor needs more than a
 *   sentence to start its work.
 *
 * Callers wanting stronger static typing can wrap the supervisor in
 * their own typed function — the runtime accepts both shapes
 * uniformly. Object inputs are JSON-stringified when forwarded to a
 * child agent without an explicit `entry.input(ctx)` override; supply
 * the override when the agent should see anything other than `JSON.stringify(input)`.
 */
export type SupervisorInput = string | Record<string, unknown>;
