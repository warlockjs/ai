import type { AgentContract } from "../../contracts/agent/agent.contract";
import type { PlannerCapability } from "../../contracts/planner/planner-capability.type";
import type { PlannerPlan } from "../../contracts/planner/planner-plan.type";
import type { BaseReport } from "../../contracts/result/base-report.type";
import type { BaseResult } from "../../contracts/result/base-result.type";
import type { Usage } from "../../contracts/result/usage.type";
import type { AIError } from "../../errors/ai-error";

/**
 * Test-only fakes for the planner DAG / replan / approval specs.
 *
 * The planner only ever calls `planningAgent.execute(...)` and
 * `capability.executable.execute(...)`, so these fakes implement just
 * those surfaces (cast to the full contracts) and let a spec script the
 * exact `{ data, usage, report }` envelopes each call returns.
 */

/** Zero-cost usage block — the common case for a canned capability result. */
export const ZERO_USAGE: Usage = { input: 0, output: 0, total: 0 };

/**
 * Build a planning agent that returns the supplied plans in order, one
 * per `execute()` call (the last plan repeats once exhausted). Records
 * the prompts it was handed so a spec can assert replan feedback reached
 * the planner. Cast to {@link AgentContract} — the planner only uses
 * `execute()`.
 */
export function fakePlanningAgent(plans: PlannerPlan[]): AgentContract<unknown> & {
  readonly prompts: string[];
  readonly calls: number;
} {
  const prompts: string[] = [];
  let cursor = 0;

  const stub = {
    name: "fake-planner",
    prompts,
    get calls(): number {
      return cursor;
    },
    async execute(prompt: string) {
      prompts.push(prompt);
      const plan = plans[Math.min(cursor, plans.length - 1)] as PlannerPlan;
      cursor++;

      return {
        type: "agent" as const,
        data: plan,
        usage: { ...ZERO_USAGE },
      };
    },
  };

  return stub as unknown as AgentContract<unknown> & {
    readonly prompts: string[];
    readonly calls: number;
  };
}

/** A canned capability outcome a {@link fakeCapability} replays per call. */
export type FakeStepOutcome = {
  /** Structured output returned as `result.data` (the planner's step output). */
  data?: unknown;
  /** Usage to roll up. Defaults to {@link ZERO_USAGE}. */
  usage?: Usage;
  /** A child report node to fold into `report.children`, if any. */
  report?: BaseReport;
  /** When set, the step fails with this error. */
  error?: AIError;
};

/**
 * Build a planner capability whose executable replays `outcomes` in order
 * (the last repeats once exhausted) and records the inputs it received.
 * Lets a spec assert per-dependency input wiring and concurrency.
 */
export function fakeCapability(
  name: string,
  outcomes: FakeStepOutcome[] = [{ data: `${name}-output` }],
  options: { onCall?: () => void | Promise<void> } = {},
): PlannerCapability & { readonly inputs: string[] } {
  const inputs: string[] = [];
  let cursor = 0;

  const executable = {
    inputs,
    async execute(input: string): Promise<BaseResult & { data?: unknown; report?: BaseReport }> {
      inputs.push(input);
      await options.onCall?.();

      const outcome = outcomes[Math.min(cursor, outcomes.length - 1)] as FakeStepOutcome;
      cursor++;

      return {
        data: outcome.data,
        usage: outcome.usage ?? { ...ZERO_USAGE },
        report: outcome.report,
        error: outcome.error,
      };
    },
  };

  return {
    name,
    description: `fake capability ${name}`,
    executable: executable as unknown as PlannerCapability["executable"],
    inputs,
  } as PlannerCapability & { readonly inputs: string[] };
}

/**
 * A capability whose executable blocks on a shared gate so a spec can
 * observe true concurrency: it increments `state.active` on entry,
 * records the peak, releases after `state.barrier` resolves. Pair with
 * {@link makeConcurrencyState}.
 */
export function concurrencyCapability(
  name: string,
  state: ConcurrencyState,
): PlannerCapability & { readonly inputs: string[] } {
  return fakeCapability(name, [{ data: `${name}-done` }], {
    onCall: async () => {
      state.active++;
      state.peak = Math.max(state.peak, state.active);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      state.active--;
    },
  });
}

/** Shared mutable state tracking concurrent in-flight capability calls. */
export type ConcurrencyState = { active: number; peak: number };

/** Fresh concurrency tracking state. */
export function makeConcurrencyState(): ConcurrencyState {
  return { active: 0, peak: 0 };
}
