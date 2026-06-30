import type { InterruptPolicy, PolicyContext } from "./contracts";

/**
 * Verdict of evaluating an {@link InterruptPolicy} against a single
 * pending tool call.
 *
 * - `requiresApproval` — `true` when the call must be routed to a human
 *   before the real tool runs; `false` when the policy lets it through
 *   untouched.
 * - `tags` — author-supplied labels from the matched rule (e.g.
 *   `"destructive"`, `"money"`), surfaced verbatim on the resulting
 *   `ApprovalRequest.context.tags`. Only ever present when
 *   `requiresApproval` is `true`; `undefined` when the rule produced no
 *   tags.
 */
export interface PolicyVerdict {
  /** Whether this tool call must be approved by a human. */
  requiresApproval: boolean;

  /** Author-supplied tags from the matched rule, when any. */
  tags?: string[];
}

/**
 * A verdict that lets a call through untouched. Frozen and shared so the
 * (common) skip path allocates nothing.
 */
const SKIP: PolicyVerdict = Object.freeze({ requiresApproval: false });

/**
 * Normalize an author-supplied tags array into the verdict shape — an
 * empty array is treated as "no tags" so callers never have to
 * distinguish `[]` from `undefined`.
 */
function withTags(tags: string[] | undefined): PolicyVerdict {
  if (tags === undefined || tags.length === 0) {
    return { requiresApproval: true };
  }

  return { requiresApproval: true, tags };
}

/**
 * Decide whether a single pending tool call requires human approval —
 * the pure core behind the `ai.human.approval` middleware's gate.
 *
 * **Pure.** No IO, no throwing, no mutation of `policy` or `context`. The
 * middleware calls this once per tool dispatch and routes to a human only
 * when {@link PolicyVerdict.requiresApproval} is `true`.
 *
 * **The three rule types** ({@link InterruptPolicy}):
 * - `allowlist` — gate the call **only** when its tool name is listed; an
 *   optional `tags(toolName)` callback derives the verdict tags.
 * - `denylist` — gate **every** call **except** the listed tool names;
 *   the same optional `tags(toolName)` callback applies to the gated
 *   (non-listed) name.
 * - `predicate` — gate the call when `requiresApproval(context)` returns a
 *   truthy result. A non-empty `string[]` both gates the call **and**
 *   supplies the verdict tags; `true` gates with no tags; `false` (or an
 *   **empty** array — "no rule matched") lets the call through.
 *
 * @param policy - The interrupt policy to evaluate.
 * @param context - The read-only view of the pending tool call.
 * @returns A {@link PolicyVerdict} — gate-or-skip plus any tags.
 *
 * @example
 * const verdict = evaluatePolicy(
 *   { type: "allowlist", tools: ["refundCustomer"], tags: () => ["money"] },
 *   { toolName: "refundCustomer", args: { amount: 50 }, agentName: "support", tripIndex: 0 },
 * );
 * // → { requiresApproval: true, tags: ["money"] }
 */
export function evaluatePolicy(
  policy: InterruptPolicy,
  context: PolicyContext,
): PolicyVerdict {
  if (policy.type === "allowlist") {
    if (!policy.tools.includes(context.toolName)) {
      return SKIP;
    }

    return withTags(policy.tags?.(context.toolName));
  }

  if (policy.type === "denylist") {
    if (policy.tools.includes(context.toolName)) {
      return SKIP;
    }

    return withTags(policy.tags?.(context.toolName));
  }

  // Predicate: a truthy result gates the call; a `string[]` doubles as the
  // verdict tags.
  const outcome = policy.requiresApproval(context);

  if (outcome === false) {
    return SKIP;
  }

  if (outcome === true) {
    return { requiresApproval: true };
  }

  // `outcome` is a `string[]`. Per the contract, an EMPTY array means "no
  // rule matched" and skips approval; a non-empty array gates the call and
  // doubles as the verdict tags.
  if (outcome.length === 0) {
    return SKIP;
  }

  return withTags(outcome);
}
