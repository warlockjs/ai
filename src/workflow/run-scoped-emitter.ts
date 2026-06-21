import type { EventIdentity } from "../contracts/events/event-identity.type";
import type { WorkflowEventMap } from "../contracts/events/event-map.type";
import type { WorkflowEventHandlers } from "../contracts/workflow/workflow.contract";
import type { WorkflowEmitter, WorkflowEventSink } from "./emitter";

/**
 * Bind a factory-scoped `WorkflowEmitter` to one run's identity.
 *
 * The engine and step-runner emit bare payloads through this sink;
 * it injects `runId` / `rootRunId` once and delegates to the real
 * three-tier emitter. This is the single place workflow run identity
 * is stamped — the alternative (editing every `emitter.emit` call
 * site) would be ~15 scattered edits and easy to miss one.
 *
 * `rootRunId === runId` for a standalone run; nested propagation
 * (a child workflow inheriting an outer run's root) lands in a
 * follow-up.
 *
 * @example
 * // Inside runWorkflow(), once per execution:
 * const emitter = runScopedEmitter(params.emitter, { runId, rootRunId: runId });
 * emitter.emit("workflow.starting", { workflowName, input }, executionHandlers);
 */
export function runScopedEmitter(
  emitter: WorkflowEmitter,
  identity: EventIdentity,
): WorkflowEventSink {
  return {
    emit(event, payload, executionHandlers?: WorkflowEventHandlers) {
      const fullPayload = {
        ...payload,
        ...identity,
      } as WorkflowEventMap[typeof event];

      emitter.emit(event, fullPayload, executionHandlers);
    },
  };
}
