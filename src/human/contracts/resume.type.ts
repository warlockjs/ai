import type { AgentContract } from "../../contracts/agent/agent.contract";
import type { AgentExecuteOptions } from "../../contracts/agent/agent-options.type";
import type { AgentResult } from "../../contracts/result/agent-result.type";
import type { ApprovalDecision } from "./approval.type";
import type { InterruptStore } from "./interrupt-store.contract";

/**
 * Options for `ai.human.resume(interruptId, decision, options)` — the
 * out-of-process resume entry point behind durable human-in-the-loop
 * approval.
 *
 * The `store` is always required: it is where the persisted
 * {@link import("./interrupt-store.contract").PendingInterrupt} is loaded
 * from and deleted after the decision is applied.
 *
 * **Two resume shapes share this one options bag:**
 * - **apply-only** — omit `agent`. The decision is loaded, validated
 *   against the persisted request, the pending record is deleted, and the
 *   `{ interruptId, decision }` is returned for the caller to re-drive the
 *   agent itself (e.g. a custom transport). No turn is re-run.
 * - **re-run** — pass `agent` (and optionally an `input` override). v1
 *   durable resume re-executes the agent turn with the decision
 *   **pre-seeded**, so the gated tool call this time resolves to the
 *   human's ruling instead of pausing again. The original prompt is
 *   re-used unless `input` overrides it.
 */
export interface ResumeOptions<TOutput = unknown> {
  /**
   * The durable store holding the {@link PendingInterrupt}. Loaded to find
   * the original request, then deleted once the decision is applied.
   */
  store: InterruptStore;

  /**
   * The agent to re-drive with the decision pre-seeded. Omit for the
   * apply-only shape (load + validate + delete, return the decision for a
   * caller-owned re-drive).
   */
  agent?: AgentContract<TOutput>;

  /**
   * Prompt for the re-run. Defaults to the original prompt captured on the
   * persisted {@link PendingInterrupt} request context; pass it to override
   * (e.g. to append the reviewer's note). Ignored when `agent` is omitted.
   */
  input?: string;

  /**
   * Extra options forwarded to `agent.execute(input, executeOptions)` on
   * the re-run (history, placeholders, output schema, signal, …). Ignored
   * when `agent` is omitted.
   */
  executeOptions?: AgentExecuteOptions<TOutput>;
}

/**
 * Outcome of `ai.human.resume(...)`.
 *
 * A discriminated union keyed on `type` (never `kind`):
 * - `"applied"` — a live `"pending"` interrupt was found, the decision was
 *   applied, and the record deleted. When the caller passed an `agent`,
 *   `result` carries the re-run's {@link AgentResult}; otherwise the caller
 *   re-drives the agent itself using the returned `decision`.
 * - `"already-resolved"` — no live interrupt for this id (already resolved
 *   + deleted, or never raised). Idempotent no-op — the decision is **not**
 *   re-applied and no turn is re-run, mirroring the orchestrator resume's
 *   drain idempotency.
 */
export type ResumeResult<TOutput = unknown> =
  | {
      type: "applied";
      /** The id of the interrupt the decision was applied to. */
      interruptId: string;
      /** The decision that was applied. */
      decision: ApprovalDecision;
      /** The re-run agent result, present only when an `agent` was supplied. */
      result?: AgentResult<TOutput>;
    }
  | {
      type: "already-resolved";
      /** The id that had no live interrupt to resume. */
      interruptId: string;
    };
