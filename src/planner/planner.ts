import { log } from "@warlock.js/logger";
import { agent } from "../agent/agent";
import type { AgentContract } from "../contracts/agent/agent.contract";
import type { PlannerCapability } from "../contracts/planner/planner-capability.type";
import type { PlannerConfig } from "../contracts/planner/planner-config.type";
import type { PlannerExecuteOptions } from "../contracts/planner/planner-execute-options.type";
import type { PlannerResult } from "../contracts/planner/planner-result.type";
import type { PlannerContract } from "../contracts/planner/planner.contract";
import { PlannerFailedError } from "../errors";
import { buildPlanSystemPrompt } from "./plan-prompt";
import { PlannerRun } from "./planner-run";
import { computeSignature } from "./signature";

const LOG_MODULE = "ai.planner";

/**
 * `ai.planner(config)` — construct a {@link PlannerContract}.
 *
 * Validates the config at author time (throws {@link PlannerFailedError}
 * on a bad shape), builds (or adopts) the plan-generation agent, computes
 * a stable structural signature, and returns an instance satisfying
 * `ExecutableContract` so the planner composes into supervisors,
 * orchestrators, and outer agents through the same uniform surface.
 *
 * At `execute(goal)` the planner asks its LLM for an ordered plan over
 * the registered `capabilities`, then executes that plan step-by-step
 * through each capability's own `execute()` — reusing the existing
 * executable machinery rather than forking it — and returns the unified
 * `{ data, report, usage, error }` envelope with `report.type ===
 * "planner"`.
 *
 * @example
 * const research = ai.planner({
 *   name: "research-assistant",
 *   model: ai.openai.model({ name: "gpt-4o" }),
 *   capabilities: [
 *     { name: "search", description: "Search the web", executable: searchAgent },
 *     { name: "write", description: "Draft a summary", executable: writerAgent },
 *   ],
 *   maxSteps: 6,
 * });
 *
 * const { data, report } = await research.execute("Compare React vs Vue in 2026");
 */
export function planner<TOutput = unknown>(
  config: PlannerConfig<TOutput>,
): PlannerContract<TOutput> {
  validateConfig(config);

  const maxSteps = config.maxSteps ?? 10;
  const capabilities = new Map<string, PlannerCapability>();

  for (const capability of config.capabilities) {
    capabilities.set(capability.name, capability);
  }

  const signature = computeSignature(config.name, config.capabilities);
  const planningAgent = resolvePlanningAgent(config, maxSteps);

  async function execute(
    goal: string,
    options?: PlannerExecuteOptions<TOutput>,
  ): Promise<PlannerResult<TOutput>> {
    log.debug(LOG_MODULE, "execute", "Planner run starting", {
      name: config.name,
      capabilities: capabilities.size,
    });

    return new PlannerRun<TOutput>({
      config,
      capabilities,
      maxSteps,
      signature,
      planningAgent,
      goal,
      options,
    }).run();
  }

  return {
    name: config.name,
    signature,
    execute,
  };
}

/**
 * Resolve the plan-generation agent: either adopt the dev's `planner`
 * agent, or build an internal one from `model` with the generated
 * plan-system-prompt baked on. The plan output schema is supplied
 * per-call in {@link PlannerRun}, so it isn't baked here.
 *
 * **`maxSteps` and BYO planners.** In `model` mode the cap is woven
 * into the generated plan-system-prompt *and* the per-call plan schema
 * (`steps.maxItems`). In `planner` (BYO) mode the dev owns the prompt,
 * so the cap is communicated only through that same per-call schema —
 * and, regardless of mode, {@link PlannerRun} truncates any over-long
 * plan to `skipped` at execution time, so the cap is always enforced.
 */
function resolvePlanningAgent<TOutput>(
  config: PlannerConfig<TOutput>,
  maxSteps: number,
): AgentContract<unknown> {
  if (config.planner) {
    return config.planner;
  }

  const systemPrompt = buildPlanSystemPrompt(config.capabilities, maxSteps, config.systemPrompt);

  return agent({
    name: `${config.name}-planner`,
    description: "Generates an ordered execution plan over the planner's capabilities.",
    model: config.model!,
    systemPrompt,
    maxTrips: 1,
  });
}

/**
 * Factory-time validation. Surfaces every violation as a typed
 * {@link PlannerFailedError} tagged `authoring: true`, mirroring the
 * supervisor/orchestrator authoring-error convention.
 */
function validateConfig<TOutput>(config: PlannerConfig<TOutput>): void {
  if (!config.name || typeof config.name !== "string") {
    throw new PlannerFailedError("ai.planner: `name` is required and must be a string", {
      context: { authoring: true },
    });
  }

  const hasModel = config.model !== undefined;
  const hasPlanner = config.planner !== undefined;

  if (!hasModel && !hasPlanner) {
    throw new PlannerFailedError(
      `ai.planner("${config.name}"): one of \`model\` or \`planner\` is required`,
      { context: { authoring: true } },
    );
  }

  if (hasModel && hasPlanner) {
    throw new PlannerFailedError(
      `ai.planner("${config.name}"): \`model\` and \`planner\` are mutually exclusive — configure exactly one`,
      { context: { authoring: true } },
    );
  }

  if (!Array.isArray(config.capabilities) || config.capabilities.length === 0) {
    throw new PlannerFailedError(
      `ai.planner("${config.name}"): at least one capability is required`,
      { context: { authoring: true } },
    );
  }

  const seen = new Set<string>();

  for (const capability of config.capabilities) {
    if (!capability || typeof capability.name !== "string" || capability.name.length === 0) {
      throw new PlannerFailedError(
        `ai.planner("${config.name}"): every capability needs a non-empty \`name\``,
        { context: { authoring: true } },
      );
    }

    if (typeof capability.description !== "string" || capability.description.length === 0) {
      throw new PlannerFailedError(
        `ai.planner("${config.name}"): capability "${capability.name}" needs a \`description\``,
        { context: { authoring: true } },
      );
    }

    if (!capability.executable || typeof capability.executable.execute !== "function") {
      throw new PlannerFailedError(
        `ai.planner("${config.name}"): capability "${capability.name}" needs an \`executable\` with an execute() method`,
        { context: { authoring: true } },
      );
    }

    if (seen.has(capability.name)) {
      throw new PlannerFailedError(
        `ai.planner("${config.name}"): duplicate capability name "${capability.name}"`,
        { context: { authoring: true } },
      );
    }

    seen.add(capability.name);
  }

  if (config.maxSteps !== undefined && config.maxSteps < 1) {
    throw new PlannerFailedError(`ai.planner("${config.name}"): \`maxSteps\` must be >= 1`, {
      context: { authoring: true, maxSteps: config.maxSteps },
    });
  }
}
