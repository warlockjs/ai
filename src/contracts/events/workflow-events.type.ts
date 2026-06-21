import type { WorkflowResult } from "../result/workflow-result.type";

export type WorkflowStartingPayload = {
  workflowName: string;
  input: unknown;
};

export type WorkflowStepStartingPayload = { step: string };

export type WorkflowStepStreamingPayload = { step: string; delta: string };

export type WorkflowStepCompletedPayload = {
  step: string;
  output: unknown;
  duration: number;
};

export type WorkflowStepSkippedPayload = { step: string };

export type WorkflowStepRetryingPayload = {
  step: string;
  attempt: number;
  totalAttempts: number;
  lastError: unknown;
};

export type WorkflowStepFailedPayload = {
  step: string;
  error: unknown;
  attempts: number;
};

export type WorkflowLoopWarningPayload = {
  step: string;
  enteredCount: number;
  lastGoto: string | null;
};

export type WorkflowCancelledPayload = {
  cancelledAt: string;
  reason: string;
};

export type WorkflowCompletedPayload = { result: WorkflowResult<unknown> };

export type WorkflowErrorPayload = { error: unknown };
