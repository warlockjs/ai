import type { PlannerCapability } from "../contracts/planner/planner-capability.type";
import type { SystemPromptContract } from "../contracts/system-prompt.contract";

/**
 * Assemble the plan-generation system prompt: optional caller framing on
 * top, then the mechanical block listing every capability + its
 * description and the rules for emitting an ordered plan.
 *
 * Runs once at factory time (the capability set is fixed for the
 * planner's lifetime) — the produced string is baked onto the internal
 * planning agent.
 */
export function buildPlanSystemPrompt(
  capabilities: PlannerCapability[],
  maxSteps: number,
  prefix: SystemPromptContract | string | undefined,
): string {
  const capabilityLines = capabilities.map(
    (capability) => `- ${capability.name}: ${capability.description}`,
  );

  const sections: string[] = [];
  const resolvedPrefix = resolvePrefix(prefix);

  if (resolvedPrefix && resolvedPrefix.trim().length > 0) {
    sections.push(resolvedPrefix.trim(), "");
  }

  sections.push(
    "You are a planner. Break the user's goal into an ordered sequence of steps,",
    "each one dispatching exactly one of the available capabilities below.",
    "",
    "Available capabilities:",
    ...capabilityLines,
    "",
    "Rules:",
    `- Produce at most ${maxSteps} steps.`,
    "- Each step's `capability` must be exactly one name from the list above.",
    "- Each step's `input` is the concrete instruction passed to that capability.",
    "- Order the steps so each builds on the outputs of the ones before it.",
    "- Never invent a capability name that is not listed.",
    "- Keep the plan minimal — only the steps actually needed to satisfy the goal.",
  );

  return sections.join("\n");
}

/**
 * Resolve a caller-supplied `systemPrompt` (string or contract) to plain
 * text. Returns `undefined` when none was supplied.
 */
function resolvePrefix(prompt: SystemPromptContract | string | undefined): string | undefined {
  if (!prompt) {
    return undefined;
  }

  return typeof prompt === "string" ? prompt : prompt.resolve();
}
