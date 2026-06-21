import { END } from "../contracts/end.type";
import type { IterationSnapshot } from "../contracts/supervisor/iteration-snapshot.type";
import type { SupervisorInput } from "../contracts/supervisor/supervisor-input.type";
import type { ResolvedIntentEntry } from "./entries";

/**
 * Build the per-turn user message the supervisor feeds to the router
 * agent. Carries everything the LLM needs to make a routing decision:
 *
 * - Available intents with descriptions (so the router knows what
 *   to pick from).
 * - The reserved `END` sentinel value it can emit to terminate.
 * - Iteration counter + ceiling so the router can pace itself.
 * - Compact history of prior iterations (intent + short output clip).
 * - The supervisor's original input so the router stays anchored.
 *
 * Note the router's own `systemPrompt` is kept persistent across
 * turns — this function produces only the per-turn USER message.
 */
export function buildRouterContextMessage(params: {
  entries: Map<string, ResolvedIntentEntry>;
  iteration: number;
  maxIterations: number;
  iterations: IterationSnapshot[];
  input: SupervisorInput;
  /**
   * Per-execute state at the START of this iteration (post-merge of
   * the previous iteration). Rendered as a JSON snippet so the
   * router can pick the next intent based on what's already filled
   * in (Q14).
   */
  state?: Record<string, unknown>;
  /**
   * Reviewer feedback string from the previous iteration's evaluate
   * verdict. Rendered as its own section so the router weighs it
   * alongside the intent list (Q18).
   */
  feedback?: string;
  /**
   * Supervisor-level system prompt text, when configured. Surfaced at
   * the TOP of the router's per-turn user message so the router reads
   * team/domain context before the routing mechanics block. Skipped
   * when the supervisor didn't configure `systemPrompt`.
   */
  supervisorPrompt?: string;
  /**
   * Resolved natural-language objective from `SupervisorConfig.goal`.
   * Surfaced as its own labeled section near the top of the router's
   * user message so routing decisions are objective-aware. Skipped
   * when no goal was configured.
   */
  goal?: string;
}): string {
  const {
    entries,
    iteration,
    maxIterations,
    iterations,
    input,
    state,
    feedback,
    supervisorPrompt,
    goal,
  } = params;

  const intentLines = [...entries.values()].map(
    entry => `- ${entry.intent}: ${entry.description}`,
  );

  const historyLines =
    iterations.length === 0
      ? ["(none yet)"]
      : iterations.map(snapshot => formatHistoryLine(snapshot));

  const sections: string[] = [];

  if (supervisorPrompt) {
    sections.push(supervisorPrompt.trim(), "");
  }

  if (goal) {
    sections.push("Goal:", goal.trim(), "");
  }

  sections.push(
    "Available intents:",
    ...intentLines,
    "",
    "Reserved values:",
    `- ${END} = terminate the run`,
    "",
    `Iteration: ${iteration + 1} / ${maxIterations}`,
    "",
    "History:",
    ...historyLines,
  );

  if (state && Object.keys(state).length > 0) {
    sections.push("", "Current state:", safeStringify(state));
  }

  if (feedback) {
    sections.push("", `Reviewer feedback from last iteration: ${feedback}`);
  }

  const renderedInput =
    typeof input === "string" ? input : safeStringify(input);

  sections.push("", `Original input: ${renderedInput}`);

  return sections.join("\n");
}

function formatHistoryLine(snapshot: IterationSnapshot): string {
  const branches = Object.entries(snapshot.result).map(
    ([intent, branch]) => `${intent} → ${clip(branch.output)}`,
  );

  return `[${snapshot.iteration}] ${branches.join(" | ")}`;
}

function clip(value: unknown, maxLength = 160): string {
  if (value === undefined || value === null) {
    return String(value);
  }

  const raw = typeof value === "string" ? value : safeStringify(value);

  if (raw.length <= maxLength) {
    return raw;
  }

  return `${raw.slice(0, maxLength - 1)}…`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return `[unserializable: ${typeof value}]`;
  }
}
