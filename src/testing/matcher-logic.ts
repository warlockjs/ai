import type { StandardSchemaV1 } from "@standard-schema/spec";
import { END } from "../contracts/end.type";
import type { BaseReport } from "../contracts/result/base-report.type";
import type { SupervisorReport } from "../contracts/result/supervisor-result.type";
import type { WorkflowReport } from "../contracts/result/workflow-result.type";

/**
 * Normalized matcher verdict — the library-agnostic shape every
 * matcher in this module returns. Vitest's `expect.extend` consumes
 * the same `{ pass, message }` contract, so the registration layer
 * forwards these verbatim.
 */
export type MatcherVerdict = {
  /** Whether the assertion passed. */
  pass: boolean;
  /** Lazy message factory — Vitest calls it only when reporting. */
  message: () => string;
};

/**
 * Any unified result envelope a matcher can be handed. Accepts the
 * full `{ report, ... }` result or a bare `BaseReport` so callers can
 * assert against either `await x.execute()` or `result.report`.
 */
type ReportLike = BaseReport | { report: BaseReport };

/**
 * Coerce a matcher target into its `BaseReport`. Accepts the result
 * envelope (`{ report }`) or a report directly.
 */
function toReport(received: ReportLike): BaseReport {
  if ("report" in received && received.report) {
    return received.report;
  }

  return received as BaseReport;
}

/** Narrow a `BaseReport` to a `SupervisorReport` by its discriminator. */
function asSupervisorReport(report: BaseReport): SupervisorReport | undefined {
  return report.type === "supervisor" ? (report as SupervisorReport) : undefined;
}

/** Narrow a `BaseReport` to a `WorkflowReport` by its discriminator. */
function asWorkflowReport(report: BaseReport): WorkflowReport | undefined {
  return report.type === "workflow" ? (report as WorkflowReport) : undefined;
}

/**
 * Collect every intent name dispatched by a supervisor across all
 * iterations — the keys of each iteration snapshot's `result` record.
 */
function dispatchedIntents(report: SupervisorReport): string[] {
  const intents = new Set<string>();

  for (const snapshot of report.snapshots) {
    for (const intent of Object.keys(snapshot.result)) {
      intents.add(intent);
    }
  }

  return [...intents];
}

/**
 * Assert that a supervisor routed to (dispatched) the named intent at
 * least once across its iterations. Targets a `SupervisorResult` or a
 * `SupervisorReport`.
 *
 * @example
 * expect(await supervisor.execute(input)).toRouteTo("critic");
 */
export function matchRouteTo(received: ReportLike, intent: string): MatcherVerdict {
  const report = toReport(received);
  const supervisorReport = asSupervisorReport(report);

  if (!supervisorReport) {
    return {
      pass: false,
      message: () =>
        `toRouteTo expects a supervisor result, but received a "${report.type}" report`,
    };
  }

  const intents = dispatchedIntents(supervisorReport);
  const pass = intents.includes(intent);

  return {
    pass,
    message: () =>
      pass
        ? `expected supervisor not to route to "${intent}", but it did`
        : `expected supervisor to route to "${intent}", but it routed to [${intents.join(", ")}]`,
  };
}

/**
 * Assert that a supervisor converged — terminated on its own decision
 * (`router` / `route` / `evaluate` / `classifier`) with a
 * `"completed"` status, rather than hitting the iteration cap, being
 * cancelled, or erroring. Targets a `SupervisorResult` or
 * `SupervisorReport`.
 *
 * @example
 * expect(await supervisor.execute(input)).toConverge();
 */
export function matchConverge(received: ReportLike): MatcherVerdict {
  const report = toReport(received);
  const supervisorReport = asSupervisorReport(report);

  if (!supervisorReport) {
    return {
      pass: false,
      message: () =>
        `toConverge expects a supervisor result, but received a "${report.type}" report`,
    };
  }

  const nonConvergent = new Set(["max-iterations", "cancelled", "error"]);
  const pass =
    supervisorReport.status === "completed" &&
    !nonConvergent.has(supervisorReport.terminatedBy);

  return {
    pass,
    message: () =>
      pass
        ? `expected supervisor not to converge, but it terminated via "${supervisorReport.terminatedBy}"`
        : `expected supervisor to converge, but status="${supervisorReport.status}" terminatedBy="${supervisorReport.terminatedBy}" after ${supervisorReport.iterations} iteration(s)`,
  };
}

/**
 * Assert that a workflow step completed successfully. Targets a
 * `WorkflowResult` or `WorkflowReport`; looks the step up by name in
 * `report.steps` and checks its status is `"completed"`.
 *
 * @example
 * expect(await workflow.execute(input)).toPassStep("draft");
 */
export function matchPassStep(received: ReportLike, stepName: string): MatcherVerdict {
  const report = toReport(received);
  const workflowReport = asWorkflowReport(report);

  if (!workflowReport) {
    return {
      pass: false,
      message: () =>
        `toPassStep expects a workflow result, but received a "${report.type}" report`,
    };
  }

  const step = workflowReport.steps[stepName];

  if (!step) {
    const known = Object.keys(workflowReport.steps).join(", ");
    return {
      pass: false,
      message: () =>
        `expected workflow to have a step "${stepName}", but steps are [${known}]`,
    };
  }

  const pass = step.status === "completed";

  return {
    pass,
    message: () =>
      pass
        ? `expected step "${stepName}" not to pass, but it completed`
        : `expected step "${stepName}" to pass, but its status was "${step.status}"`,
  };
}

/**
 * Result envelope carrying a typed `data` payload — what
 * `matchOutputShape` validates against a schema.
 */
type DataResult = { data?: unknown };

/**
 * Assert that a result's `data` validates against a Standard Schema.
 * Targets any result envelope with a `data` field (agent / workflow /
 * supervisor). Runs the schema's `~standard.validate` and passes only
 * when it reports no issues.
 *
 * Synchronous-only: a schema whose `validate` returns a Promise is
 * rejected with a clear message rather than silently passing — the
 * async variant belongs on a dedicated async matcher if needed.
 *
 * @example
 * expect(await agent.execute(input, { output: schema })).toOutputShape(schema);
 */
export function matchOutputShape(
  received: DataResult,
  schema: StandardSchemaV1,
): MatcherVerdict {
  const data = received.data;

  if (data === undefined) {
    return {
      pass: false,
      message: () => "toOutputShape expected result.data to be defined, but it was undefined",
    };
  }

  const validation = schema["~standard"].validate(data);

  if (validation instanceof Promise) {
    return {
      pass: false,
      message: () =>
        "toOutputShape received an async schema; use a synchronous Standard Schema for this matcher",
    };
  }

  const pass = validation.issues === undefined;

  return {
    pass,
    message: () => {
      if (pass) {
        return "expected result.data not to match the schema, but it did";
      }

      const summary = (validation.issues ?? []).map((issue) => issue.message).join("; ");
      return `expected result.data to match the schema, but validation failed: ${summary}`;
    },
  };
}

// Re-exported so matcher consumers and tests can reference the
// termination sentinel without reaching into contracts.
export { END };
