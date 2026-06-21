import { WorkflowError } from "../errors";

/**
 * Deep-clone workflow state. Uses `structuredClone` — handles Date,
 * Map, Set, ArrayBuffer, nested objects, arrays, primitives. Throws
 * a typed `WorkflowError` on older runtimes (pre-Node-17) rather
 * than silently falling back to a JSON round-trip that would drop
 * non-serializable values like Dates without warning.
 *
 * Workflow state should stay serializable anyway (it round-trips
 * through `KVStore` on every checkpoint). If `structuredClone` chokes
 * on a value, that's a bug in the user's state — surface it.
 */
export function cloneState<T>(value: T): T {
  if (typeof structuredClone !== "function") {
    throw new WorkflowError(
      "workflow state cloning requires `structuredClone` (Node 17+ or a modern browser)",
    );
  }

  return structuredClone(value);
}

/**
 * Recursively freeze `value` and every nested plain object / array so
 * consumers of `ctx.steps[x].state` or `report.state` can't mutate
 * historical snapshots. Already-frozen values are skipped.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;

  for (const key of Object.keys(value as Record<string, unknown>)) {
    const child = (value as Record<string, unknown>)[key];
    if (child && typeof child === "object") deepFreeze(child);
  }

  return Object.freeze(value);
}
