/**
 * Configuration for the stream-time tool-call guard.
 *
 * **What the guard does.** Cheap/fast models occasionally emit the
 * structured input for a registered tool as **literal text in the
 * content stream** instead of as a structured tool-call. Without
 * intervention, the customer watches raw JSON build up
 * character-by-character on screen — every `delta` already shipped
 * over the wire before anyone can react. The guard sits at the
 * delta-processing seam inside the agent loop, scans incoming text
 * for a JSON envelope that matches a registered tool's name + schema,
 * and — when matched — synthesizes a real tool call while dropping
 * the leaked JSON from visible text.
 *
 * **Opt-in by design.** Absent = off (faithful relay, no mutation).
 * Empty object `{}` = on with defaults. Mutating the stream behind a
 * developer's back violates least surprise — set this explicitly when
 * the agent has tools that the model has been observed to leak.
 *
 * **What survives the guard.**
 * - Legitimate prose streams verbatim; the guard only engages when a
 *   `{` or ```` ```json ```` opener appears in the text channel.
 * - A buffered JSON blob that does NOT match the named-envelope
 *   pattern (envelope `{ name|tool, arguments|input }` whose tool is
 *   registered AND whose args validate against the tool's schema) is
 *   flushed back to the consumer as text — the developer's "give me
 *   a JSON config" prompt is preserved.
 *
 * **Limitations.**
 * - Named envelope only. Bare-object matching is unsafe while tool
 *   input schemas can be permissive (a `v.record(v.any())` matches
 *   any object); future tier, not in v1.
 * - Recovery introduces a delay equal to "time to emit the suspect
 *   JSON" — the customer sees prose up to the `{`, then waits while
 *   the buffer fills, then either sees nothing (recovered) or the
 *   JSON in one shot (flushed). Negligible in normal chat; visible
 *   only when the agent's primary output IS a JSON blob the user
 *   asked for.
 *
 * @example
 * // Always on for this agent, defaults
 * const talker = agent({
 *   model,
 *   tools: [suggestFollowupsTool],
 *   streamingToolGuard: {},
 * });
 *
 * @example
 * // Per-call override — disable for a one-off JSON-extraction call
 * await agent.execute(input, {
 *   streamingToolGuard: undefined,
 * });
 *
 * @example
 * // Tighter buffer cap for cost-sensitive deployments
 * const talker = agent({
 *   model,
 *   tools,
 *   streamingToolGuard: { maxBufferBytes: 2048 },
 * });
 */
export type StreamingToolGuardConfig = {
  /**
   * Hard cap on the bytes the guard will accumulate before deciding
   * a suspect buffer is not envelope-shaped after all. When the cap
   * is hit, the buffer flushes to the consumer as text and the guard
   * resets to pass-through.
   *
   * Defaults to `4096`. Real envelope payloads observed in production
   * leaks have been under 1 KB; the cap is a safety valve against an
   * adversarial / runaway buffer growing without bound.
   */
  maxBufferBytes?: number;
};
