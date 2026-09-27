import type { ApprovalDecision } from "./contracts";

/**
 * Process-local registry of decisions pre-seeded for a durable re-run.
 *
 * **Why it exists.** v1 durable resume re-runs the *same* agent turn with
 * the human's decision already in hand (it does **not** rehydrate an
 * in-flight supervisor — that is the deferred v2 lift). The agent's
 * `ai.human.approval(...)` middleware is baked in at construction, so the
 * re-run cannot be handed a different handler. Instead, `ai.human.resume(...)`
 * stashes the decision here keyed by the exact gated-call binding; the approval
 * middleware's handler consults the registry **before** calling the
 * author's handler and, on a hit, replays the seeded decision exactly once
 * — so the gated tool call this time resolves to the human's ruling instead
 * of pausing again.
 *
 * Keyed by the deterministic binding key (not interrupt id): the re-run
 * produces a *fresh* interrupt id, while the binding identifies the exact
 * approved action. A different action cannot consume the decision.
 */
const seededDecisions = new Map<string, ApprovalDecision>();

/**
 * Stash a decision to be replayed by the gated tool call with `bindingKey`.
 * Overwrites any prior decision for that exact binding.
 */
export function seedDecision(bindingKey: string, decision: ApprovalDecision): void {
  seededDecisions.set(bindingKey, decision);
}

/**
 * Take (read **and** remove) the seeded decision for `bindingKey`, or
 * `undefined` when none is staged. Consuming on read makes the seed
 * one-shot: only the first gated call of a re-run replays it.
 */
export function takeSeededDecision(bindingKey: string): ApprovalDecision | undefined {
  const decision = seededDecisions.get(bindingKey);

  if (decision === undefined) {
    return undefined;
  }

  seededDecisions.delete(bindingKey);

  return decision;
}

/**
 * Drop any staged seed for `bindingKey` without consuming it as a decision.
 * Used to clean up after a re-run that errored before the seeded call fired,
 * so a stale seed never leaks into an unrelated later run of the same agent.
 */
export function clearSeededDecision(bindingKey: string): void {
  seededDecisions.delete(bindingKey);
}
