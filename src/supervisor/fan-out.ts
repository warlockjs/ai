import type { AgentContract } from "../contracts/agent/agent.contract";
import type { IntentEntry } from "../contracts/supervisor/intent-entry.type";
import type { WorkflowInstance } from "../contracts/workflow/workflow.contract";

/**
 * A dispatchable unit that can be fanned out — an agent or a workflow.
 * The same union the supervisor's `intents` map accepts for its
 * agent/workflow object entries.
 */
export type FanOutUnit = AgentContract<unknown> | WorkflowInstance<unknown, unknown>;

/**
 * Options for {@link fanOut}.
 */
export type FanOutOptions = {
  /**
   * Base name for the generated intent keys. Defaults to the unit's own
   * `name`. The keys are `<keyPrefix>1`, `<keyPrefix>2`, … `<keyPrefix>n`.
   */
  keyPrefix?: string;
  /**
   * Description applied to every generated entry. Defaults to the
   * unit's own `description`. A description is required when the
   * supervisor uses a `router` (the LLM needs a signal per intent); the
   * factory enforces that downstream, so supply one here when the
   * underlying unit has none.
   */
  description?: string;
};

/**
 * Spread one agent/workflow into `n` distinctly-keyed intent entries
 * for voting / self-consistency under a supervisor.
 *
 * A supervisor dispatches a fan-out array (`["writer1", "writer2",
 * "writer3"]`) in parallel; each branch runs the SAME unit independently
 * so a downstream evaluate/aggregate intent can pick the majority answer
 * or the best of `n` samples. Because every branch needs its own intent
 * KEY, this helper clones the unit across distinct keys rather than
 * cloning the unit itself — the underlying agent/workflow is referenced
 * by all entries, but each entry is a separate dispatch slot.
 *
 * Returns a `Record<string, IntentEntry>` you spread directly into the
 * supervisor's `intents` map. The keys are `<keyPrefix>1..<keyPrefix>n`.
 *
 * @example
 * const writer = ai.agent({ name: "writer", description: "Drafts an answer.", model });
 *
 * const support = ai.supervisor({
 *   name: "self-consistency",
 *   intents: {
 *     ...ai.fanOut(writer, 3),          // writer1, writer2, writer3
 *     vote: { run: pickMajority, description: "Choose the majority answer." },
 *   },
 *   route: (ctx) =>
 *     ctx.iteration === 0 ? ["writer1", "writer2", "writer3"] : "vote",
 * });
 *
 * @param unit  The agent or workflow to fan out.
 * @param count Number of parallel copies. Must be an integer >= 1.
 * @param options Optional key-prefix / description overrides.
 */
export function fanOut(
  unit: FanOutUnit,
  count: number,
  options: FanOutOptions = {},
): Record<string, IntentEntry> {
  if (!unit || typeof (unit as { execute?: unknown }).execute !== "function") {
    throw new TypeError("ai.fanOut: first argument must be an agent or workflow");
  }

  if (!Number.isInteger(count) || count < 1) {
    throw new TypeError(`ai.fanOut: \`count\` must be an integer >= 1 (received ${String(count)})`);
  }

  const keyPrefix = resolveKeyPrefix(unit, options.keyPrefix);
  const description = options.description ?? readDescription(unit);

  const entries: Record<string, IntentEntry> = {};

  for (let index = 1; index <= count; index++) {
    const entry: IntentEntry = { agent: unit };

    if (description) {
      entry.description = description;
    }

    entries[`${keyPrefix}${index}`] = entry;
  }

  return entries;
}

/**
 * Resolve the base key prefix: explicit override wins, then the unit's
 * own name. A unit with no usable name forces an explicit `keyPrefix`
 * so the generated keys stay meaningful and collision-free.
 */
function resolveKeyPrefix(unit: FanOutUnit, override: string | undefined): string {
  if (override && override.trim().length > 0) {
    return override.trim();
  }

  const name = (unit as { name?: unknown }).name;

  if (typeof name === "string" && name.trim().length > 0) {
    return name.trim();
  }

  throw new TypeError(
    "ai.fanOut: the unit has no usable `name` — pass `options.keyPrefix` to name the generated intent keys",
  );
}

function readDescription(unit: FanOutUnit): string | undefined {
  const description = (unit as { description?: unknown }).description;

  return typeof description === "string" && description.trim().length > 0 ? description : undefined;
}
