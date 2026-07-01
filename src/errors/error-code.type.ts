/**
 * Stable machine-readable identifier for every `AIError` subclass.
 *
 * Consumers switch on `error.code` rather than `instanceof` whenever the
 * logic is "what went wrong in terms the user needs to handle" (retryable,
 * wrong API key, too long, etc.). The strings are part of the public API —
 * never rename an existing code; add a new one.
 *
 * @example
 * if (result.error?.code === "PROVIDER_RATE_LIMIT") {
 *   await sleep(result.error.retryAfter ?? 1000);
 *   return agent.execute(input);
 * }
 */
export type AIErrorCode =
  | "AGENT_EXEC_FAILED"
  | "AGENT_CANCELLED"
  | "AGENT_MAX_TRIPS"
  | "AGENT_DRIFT"
  | "SCHEMA_VALIDATION_FAILED"
  | "TOOL_EXEC_FAILED"
  | "PROVIDER_ERROR"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_QUOTA_EXCEEDED"
  | "PROVIDER_TIMEOUT"
  | "CONTEXT_LENGTH_EXCEEDED"
  | "CONTENT_FILTER"
  | "PROVIDER_INVALID_REQUEST"
  | "PROVIDER_AUTH"
  | "BUDGET_EXCEEDED"
  | "GUARDRAIL_VIOLATION"
  | "WORKFLOW_ERROR"
  | "STEP_FAILED"
  | "WORKFLOW_DRIFT"
  | "WORKFLOW_CANCELLED"
  | "WORKFLOW_MAX_STEPS"
  | "WORKFLOW_INVALID_GOTO"
  | "SUPERVISOR_FAILED"
  | "SUPERVISOR_MAX_ITERATIONS"
  | "SUPERVISOR_INVALID_ROUTE"
  | "SUPERVISOR_CANCELLED"
  | "SUPERVISOR_DRIFT"
  | "SUPERVISOR_INTENT_DESCRIPTION_REQUIRED"
  | "SUPERVISOR_INTENT_MIXED_DISPATCH"
  | "SUPERVISOR_INTENT_STREAM_AND_OUTPUT"
  | "SUPERVISOR_INTENT_STREAM_TO_REQUIRED"
  | "SUPERVISOR_INTENT_STREAM_ON_WORKFLOW"
  | "SUPERVISOR_DISPATCH_CYCLE"
  | "ORCHESTRATOR_FAILED"
  | "ORCHESTRATOR_DRIFT"
  | "ORCHESTRATOR_CONFIG"
  | "ORCHESTRATOR_CANCELLED"
  | "PLANNER_FAILED"
  | "PLANNER_PLAN_INVALID"
  | "PLANNER_CANCELLED"
  | "PLANNER_DRIFT"
  | "VCR_CASSETTE_MISS"
  | "OUTBOUND_POLICY_BLOCKED";
