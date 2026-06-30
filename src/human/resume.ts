import type {
  ApprovalDecision,
  PendingInterrupt,
  ResumeOptions,
  ResumeResult,
} from "./contracts";
import { clearSeededDecision, seedDecision } from "./resume-seed";

/**
 * Validate that a decision is a well-formed {@link ApprovalDecision}.
 *
 * `ai.human.resume(...)` is a public, out-of-process entry point — a
 * webhook can hand it anything. Guard the closed `type` union (and the
 * per-variant required fields) before applying it, so a malformed payload
 * fails loudly here rather than silently mis-driving the re-run.
 */
function assertDecision(decision: ApprovalDecision): void {
  if (decision.type === "approve") {
    return;
  }

  if (decision.type === "reject") {
    if (typeof decision.reason !== "string") {
      throw new TypeError(
        "ai.human.resume: a 'reject' decision requires a string 'reason'.",
      );
    }

    return;
  }

  if (decision.type === "edit") {
    if (!("args" in decision)) {
      throw new TypeError(
        "ai.human.resume: an 'edit' decision requires replacement 'args'.",
      );
    }

    return;
  }

  throw new TypeError(
    `ai.human.resume: unknown decision type '${(decision as { type: string }).type}'. Expected one of: approve, reject, edit.`,
  );
}

/**
 * Re-run the agent for a resumed interrupt with the decision pre-seeded.
 *
 * Stages the decision in the process-local seed registry (keyed by agent
 * name), then re-executes the original prompt. The agent's
 * `ai.human.approval(...)` middleware consumes the seed on the gated tool
 * call — so this time it resolves to the human's ruling instead of pausing
 * again. The seed is cleared in a `finally` so a re-run that errors before
 * the gated call never leaks a stale seed into a later run.
 */
async function rerun<TOutput>(
  pending: PendingInterrupt,
  decision: ApprovalDecision,
  options: ResumeOptions<TOutput>,
): Promise<ResumeResult<TOutput>> {
  const { agent } = options;

  // `agent` is guaranteed by the caller (this is only reached on the
  // re-run path), but narrow for the type system.
  if (!agent) {
    return { type: "applied", interruptId: pending.interruptId, decision };
  }

  const input = options.input ?? pending.request.context.originalInput ?? "";

  seedDecision(agent.name, decision);

  try {
    const result = await agent.execute(input, options.executeOptions);

    return {
      type: "applied",
      interruptId: pending.interruptId,
      decision,
      result,
    };
  } finally {
    // If the seeded call never fired (the re-run errored early, or the
    // policy no longer gates the tool), drop the stale seed so it cannot
    // leak into an unrelated later run of the same agent.
    clearSeededDecision(agent.name);
  }
}

/**
 * Apply a human's decision to a persisted interrupt — the out-of-process
 * resume entry point behind `ai.human.resume(interruptId, decision, options)`.
 *
 * **Durable v1 model — re-run, not mid-supervisor suspend.** This loads the
 * {@link PendingInterrupt} from `options.store`, validates the decision,
 * deletes the pending record, and (when an `agent` is supplied) re-executes
 * the original turn with the decision **pre-seeded**, so the gated tool call
 * resolves to the ruling instead of pausing again. It does **not** rehydrate
 * an in-flight supervisor — that is the deferred v2 lift.
 *
 * **Idempotent.** A second resume of an already-resolved (deleted) or
 * never-raised interrupt is a no-op: it returns `{ type: "already-resolved" }`
 * without re-applying the decision or re-running the turn — mirroring the
 * orchestrator resume's drain idempotency. The record is deleted **before**
 * the re-run, so even a re-run that itself raises a fresh interrupt cannot
 * collide with the one being resolved.
 *
 * **Two shapes** (see {@link ResumeOptions}):
 * - **apply-only** — omit `agent`: load, validate, delete, return
 *   `{ type: "applied", decision }` for a caller-owned re-drive.
 * - **re-run** — pass `agent`: additionally re-execute the turn; the
 *   {@link import("@warlock.js/ai").AgentResult} rides `result.result`.
 *
 * @param interruptId - Id of the persisted interrupt to resolve.
 * @param decision - The human's ruling (approve / reject / edit).
 * @param options - The durable `store` (required) plus optional re-run
 *   `agent` / `input` / `executeOptions`.
 * @returns A {@link ResumeResult} — `"applied"` or idempotent
 *   `"already-resolved"`.
 *
 * @example
 * // Process B (webhook, hours later) — apply-only:
 * const outcome = await ai.human.resume(interruptId, { type: "reject", reason: "Out of policy" }, {
 *   store,
 * });
 *
 * @example
 * // Re-run the turn with the decision pre-seeded:
 * const outcome = await ai.human.resume(interruptId, { type: "edit", args: { amount: 5 } }, {
 *   store,
 *   agent: support,
 * });
 * if (outcome.type === "applied" && outcome.result) {
 *   console.log(outcome.result.text);
 * }
 */
export async function resume<TOutput = unknown>(
  interruptId: string,
  decision: ApprovalDecision,
  options: ResumeOptions<TOutput>,
): Promise<ResumeResult<TOutput>> {
  assertDecision(decision);

  const { store } = options;
  const pending = await store.load(interruptId);

  // No live interrupt — already resolved + deleted, or never raised. Never
  // double-apply; never re-run. Idempotent no-op.
  if (pending === undefined || pending.status !== "pending") {
    return { type: "already-resolved", interruptId };
  }

  // Resolve + delete BEFORE the re-run so a re-run that itself raises a new
  // interrupt cannot collide with the one being resolved, and a concurrent
  // resume of the same id sees it gone.
  await store.delete(interruptId);

  if (!options.agent) {
    return { type: "applied", interruptId, decision };
  }

  return rerun(pending, decision, options);
}
