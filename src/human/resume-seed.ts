import type { ApprovalDecision } from "./contracts";

/**
 * Process-local registry of decisions pre-seeded for a durable re-run.
 *
 * **Why it exists.** v1 durable resume re-runs the *same* agent turn with
 * the human's decision already in hand (it does **not** rehydrate an
 * in-flight supervisor — that is the deferred v2 lift). The agent's
 * `ai.human.approval(...)` middleware is baked in at construction, so the
 * re-run cannot be handed a different handler. Instead, `ai.human.resume(...)`
 * stashes the decision here keyed by the agent name; the approval
 * middleware's handler consults the registry **before** calling the
 * author's handler and, on a hit, replays the seeded decision exactly once
 * — so the gated tool call this time resolves to the human's ruling instead
 * of pausing again.
 *
 * Keyed by agent name (not interrupt id): the re-run produces a *fresh*
 * interrupt id (the id embeds a random segment), so the seed must be
 * matched to the run, not the prior id. The registry holds at most one
 * seeded decision per agent and consumes it on first read, so a second
 * gated call in the same re-run falls through to the author's handler.
 */
const seededDecisions = new Map<string, ApprovalDecision>();

/**
 * Stash a decision to be replayed on the next gated tool call of `agentName`.
 * Overwrites any prior seed for the same agent (a re-run carries exactly one
 * pre-seeded decision).
 */
export function seedDecision(agentName: string, decision: ApprovalDecision): void {
  seededDecisions.set(agentName, decision);
}

/**
 * Take (read **and** remove) the seeded decision for `agentName`, or
 * `undefined` when none is staged. Consuming on read makes the seed
 * one-shot: only the first gated call of a re-run replays it.
 */
export function takeSeededDecision(agentName: string): ApprovalDecision | undefined {
  const decision = seededDecisions.get(agentName);

  if (decision === undefined) {
    return undefined;
  }

  seededDecisions.delete(agentName);

  return decision;
}

/**
 * Drop any staged seed for `agentName` without consuming it as a decision.
 * Used to clean up after a re-run that errored before the seeded call fired,
 * so a stale seed never leaks into an unrelated later run of the same agent.
 */
export function clearSeededDecision(agentName: string): void {
  seededDecisions.delete(agentName);
}
