import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { FlowObserveOption } from "../../observe/resolve-observers";
import type { AgentContract } from "../agent/agent.contract";
import type { ModelContract } from "../model.contract";
import type { SystemPromptContract } from "../system-prompt.contract";
import type { PlannerCapability } from "./planner-capability.type";

/**
 * Factory config for `ai.planner(config)`.
 *
 * The planner asks an LLM to GENERATE an ordered plan over the
 * registered `capabilities`, then executes that plan step-by-step
 * through each capability's own `execute()`. It is itself an
 * executable — composes into agents, supervisors, and orchestrators
 * through the same `ExecutableContract` surface.
 *
 * Exactly one of `model` or `planner` must be supplied as the
 * plan-generation brain: `model` builds an internal planning agent
 * automatically; `planner` lets the dev bring a fully-configured agent
 * (custom system prompt, middleware, output guard) to do the planning.
 *
 * @example
 * const research = ai.planner({
 *   name: "research-assistant",
 *   model: ai.openai.model({ name: "gpt-4o" }),
 *   capabilities: [
 *     { name: "search", description: "Search the web", executable: searchAgent },
 *     { name: "summarize", description: "Summarize text", executable: summarizer },
 *   ],
 *   maxSteps: 6,
 * });
 *
 * const { data, report } = await research.execute("Compare React vs Vue in 2026");
 */
export type PlannerConfig<TOutput = unknown> = {
  /** Stable identifier — used in logs, events, signature, report `name`. */
  name: string;
  /** Dev-curated version string. Metadata only — never parsed. */
  version?: string;
  /**
   * Per-flow observability routing. `true` routes this planner's report to
   * the globally-registered observers (even with observe-all off); `false`
   * opts out; an `Observer` is a flow-local collector; omitted follows the
   * global observe-all flag. Brings the planner to parity with
   * agent/workflow/supervisor instead of only ever routing under observe-all.
   */
  observe?: FlowObserveOption;
  /**
   * Model used to build the internal planning agent that GENERATES the
   * plan. Mutually exclusive with `planner`.
   */
  model?: ModelContract;
  /**
   * Bring-your-own planning agent. Its `execute()` is asked for the
   * structured plan (the planner supplies the plan schema as the
   * agent's `output`). Mutually exclusive with `model`.
   */
  planner?: AgentContract<unknown>;
  /**
   * Extra instruction prepended to the plan-generation prompt
   * (`model` mode only — ignored when `planner` is supplied, since the
   * dev's agent owns its own prompt).
   */
  systemPrompt?: SystemPromptContract | string;
  /**
   * The capabilities the plan may reference. The planner injects each
   * one's `name` + `description` into the plan-generation prompt and
   * dispatches the chosen capability per step.
   */
  capabilities: PlannerCapability[];
  /**
   * Hard cap on the number of plan steps the planner will execute. A
   * generated plan longer than this is truncated to the cap (the
   * dropped tail is recorded as `skipped` on the report). Defaults to
   * 10. Must be >= 1.
   */
  maxSteps?: number;
  /**
   * Final-output schema. When set, the planner validates the last
   * completed step's output against it before populating
   * `result.data`. Omit to pass the final step's raw output through
   * untyped.
   */
  output?: StandardSchemaV1<TOutput>;
  /**
   * Schedule independent steps in parallel off `dependsOn`. When true the
   * planner builds a DAG from step `id` / `dependsOn`, runs each ready
   * level concurrently, and feeds each step ONLY its dependencies'
   * outputs. A cycle or a `dependsOn` that names an unknown step raises a
   * typed {@link import("../../errors/planner-plan-invalid-error").PlannerPlanInvalidError}
   * before any step runs. Default `false` ⇒ today's strict array-order
   * loop, byte-for-byte unchanged.
   */
  dag?: boolean;
  /** Max concurrent steps when `dag` is true. Default 4. */
  maxConcurrency?: number;
  /**
   * Adaptive re-planning. When set, a failed step (or a `replan` verdict
   * from the `onStep` execute-option) revises the REMAINING plan instead
   * of aborting — re-asking the planning agent for a fresh plan seeded
   * with the executed-step digest plus the feedback. Bounded by
   * `maxReplans`; on exhaustion the run ends with the last failure.
   * Default off ⇒ a failure aborts exactly as today.
   */
  replan?: { maxReplans: number };
};
