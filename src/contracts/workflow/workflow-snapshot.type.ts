import type { ExecutionStatus } from "../result/execution-report.type";
import type { StepSnapshot } from "../result/step-result.type";

/**
 * Serializable workflow state written to the configured `KVStore`
 * after every step completion.
 */
export type WorkflowSnapshot = {
  runId: string;
  workflowName: string;
  signature: string;
  version?: string;
  input: unknown;
  state: Record<string, unknown>;
  steps: Record<string, StepSnapshot>;
  /** Resolved next step name; null when the workflow has ended. */
  next: string | null;
  status: ExecutionStatus | "running";
  startedAt: string;
  savedAt: string;
};
