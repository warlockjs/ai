import type {
  AgentCompletedPayload,
  AgentErrorPayload,
  AgentStartingPayload,
  AgentStreamingPayload,
  AgentToolCalledPayload,
  AgentToolCallingFailedPayload,
  AgentToolCallingPayload,
  AgentTripCompletedPayload,
  AgentTripStartedPayload,
} from "./agent-events.type";
import type { EventIdentity } from "./event-identity.type";
import type {
  SupervisorAckCompletedPayload,
  SupervisorAckStreamingPayload,
  SupervisorAgentCompletedPayload,
  SupervisorAgentFailedPayload,
  SupervisorAgentStartingPayload,
  SupervisorAgentStreamingPayload,
  SupervisorCancelledPayload,
  SupervisorClassifierCompletedPayload,
  SupervisorClassifierFailedPayload,
  SupervisorClassifierStartingPayload,
  SupervisorClassifierStreamingPayload,
  SupervisorCompletedPayload,
  SupervisorErrorPayload,
  SupervisorEvaluateVerdictPayload,
  SupervisorIterationCompletedPayload,
  SupervisorIterationStartingPayload,
  SupervisorRouterDecidedPayload,
  SupervisorRouterDecidingPayload,
  SupervisorStartingPayload,
} from "./supervisor-events.type";
import type {
  WorkflowCancelledPayload,
  WorkflowCompletedPayload,
  WorkflowErrorPayload,
  WorkflowLoopWarningPayload,
  WorkflowStartingPayload,
  WorkflowStepCompletedPayload,
  WorkflowStepFailedPayload,
  WorkflowStepRetryingPayload,
  WorkflowStepSkippedPayload,
  WorkflowStepStartingPayload,
  WorkflowStepStreamingPayload,
} from "./workflow-events.type";

/**
 * Apply run identity to every value of an event map. The central
 * `emit` chokepoint of each primitive injects `runId` / `rootRunId`,
 * so subscribers always receive them while call sites stay
 * identity-free (see `WithoutIdentity`).
 */
type WithIdentity<TMap> = { [K in keyof TMap]: TMap[K] & EventIdentity };

/**
 * Event map for agent execution. Keys use dot-notation so every event
 * name is unambiguous across primitives (agent vs workflow vs supervisor)
 * and so consumers can group or filter by prefix (`agent.*`, `agent.tool.*`).
 *
 * Every payload carries `EventIdentity` (`runId` / `rootRunId`),
 * injected centrally by the agent's `emit` so consumers can correlate
 * any event back to its run without an out-of-band closure.
 */
export type AgentEventMap = WithIdentity<{
  "agent.starting": AgentStartingPayload;
  "agent.trip.started": AgentTripStartedPayload;
  "agent.trip.streaming": AgentStreamingPayload;
  "agent.trip.completed": AgentTripCompletedPayload;
  "agent.tool.calling": AgentToolCallingPayload;
  "agent.tool.called": AgentToolCalledPayload;
  "agent.tool.failed": AgentToolCallingFailedPayload;
  "agent.completed": AgentCompletedPayload;
  "agent.error": AgentErrorPayload;
}>;

/** Event map for workflow execution. Every payload carries `EventIdentity`. */
export type WorkflowEventMap = WithIdentity<{
  "workflow.starting": WorkflowStartingPayload;
  "workflow.step.starting": WorkflowStepStartingPayload;
  "workflow.step.streaming": WorkflowStepStreamingPayload;
  "workflow.step.completed": WorkflowStepCompletedPayload;
  "workflow.step.skipped": WorkflowStepSkippedPayload;
  "workflow.step.retrying": WorkflowStepRetryingPayload;
  "workflow.step.failed": WorkflowStepFailedPayload;
  "workflow.loop.warning": WorkflowLoopWarningPayload;
  "workflow.cancelled": WorkflowCancelledPayload;
  "workflow.completed": WorkflowCompletedPayload;
  "workflow.error": WorkflowErrorPayload;
}>;

/**
 * Event map for supervisor execution. Three-tier subscription —
 * definition, instance, per-call — fires in that order on every
 * emission. Router-only events (`supervisor.router.*`) are skipped
 * entirely in deterministic `route`-callback mode.
 *
 * Every payload carries `EventIdentity` (`runId` / `rootRunId`),
 * injected centrally by `SupervisorExecution.emit`.
 */
export type SupervisorEventMap = WithIdentity<{
  "supervisor.starting": SupervisorStartingPayload;
  "supervisor.iteration.starting": SupervisorIterationStartingPayload;
  "supervisor.router.deciding": SupervisorRouterDecidingPayload;
  "supervisor.router.decided": SupervisorRouterDecidedPayload;
  "supervisor.agent.starting": SupervisorAgentStartingPayload;
  "supervisor.agent.streaming": SupervisorAgentStreamingPayload;
  "supervisor.agent.completed": SupervisorAgentCompletedPayload;
  "supervisor.agent.failed": SupervisorAgentFailedPayload;
  "supervisor.ack.streaming": SupervisorAckStreamingPayload;
  "supervisor.ack.completed": SupervisorAckCompletedPayload;
  "supervisor.classifier.starting": SupervisorClassifierStartingPayload;
  "supervisor.classifier.streaming": SupervisorClassifierStreamingPayload;
  "supervisor.classifier.completed": SupervisorClassifierCompletedPayload;
  "supervisor.classifier.failed": SupervisorClassifierFailedPayload;
  "supervisor.evaluate.verdict": SupervisorEvaluateVerdictPayload;
  "supervisor.iteration.completed": SupervisorIterationCompletedPayload;
  "supervisor.cancelled": SupervisorCancelledPayload;
  "supervisor.completed": SupervisorCompletedPayload;
  "supervisor.error": SupervisorErrorPayload;
}>;
