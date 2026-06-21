/**
 * Generates a stable, human-readable run id for any execution node
 * (tool invocation, agent run, workflow run, supervisor run). Format:
 * `${prefix}_${timestamp36}_${random36}` — compact, sortable by
 * prefix, collision-resistant within a run.
 *
 * Shared helper so every primitive emits the same id shape. The
 * prefix is conventionally the primitive kind (`"tool"`, `"agent"`,
 * `"workflow"`, `"sup"`) but callers can pass anything; the id is
 * purely for correlation, never parsed.
 *
 * @example
 * const runId = generateRunId("tool");
 * // → "tool_ld8x3m_7fq2j1kp"
 */
export function generateRunId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}
