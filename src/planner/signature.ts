import type { PlannerCapability } from "../contracts/planner/planner-capability.type";

/**
 * Delimiter between capability names in a planner signature. A NUL
 * control character can never appear in a real capability name, so it
 * keeps name boundaries unambiguous — a single capability literally
 * named `"a,b"` can never collide with the two capabilities
 * `["a", "b"]` (a comma delimiter would render both as `caps:a,b`).
 */
const CAPABILITY_DELIMITER = String.fromCharCode(0);

/**
 * Compute a stable structural fingerprint for a planner definition —
 * the planner name plus its ordered capability names. Stamped on every
 * report node the planner produces so trace consumers can tell runs of
 * structurally-different planners apart even when they share a name.
 *
 * Deliberately coarse: it captures WHICH capabilities the planner can
 * dispatch (and in what registration order), not their descriptions or
 * the underlying executables' internals — those don't change the set of
 * plans the planner can produce.
 */
export function computeSignature(name: string, capabilities: PlannerCapability[]): string {
  const capabilityNames = capabilities
    .map((capability) => capability.name)
    .join(CAPABILITY_DELIMITER);

  return `planner:${name}|caps:${capabilityNames}`;
}
