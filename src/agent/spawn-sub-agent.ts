import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AgentExecuteOptions } from "../contracts/agent/agent-options.type";
import type { AgentContract } from "../contracts/agent/agent.contract";
import type { AgentResult } from "../contracts/result/agent-result.type";
import type { ModelContract } from "../contracts/model.contract";
import type { SystemPromptContract } from "../contracts/system-prompt.contract";
import { budget, type BudgetOptions } from "../middleware/builtins/budget";
import type { AgentToolEntry } from "../tool/executable-as-tool";
import { agent } from "./agent";

/**
 * Spec for `spawnSubAgent` — a one-shot agent invocation. `spawnSubAgent`
 * is a thin convenience wrapper: it builds a fresh `agent()` from this
 * spec, optionally attaches a `budget` middleware, runs the `task` once,
 * and returns the `AgentResult`. There is no separate "sub-agent" runtime
 * — a spawn is an ordinary new `agent()` instance, so it starts from an
 * empty conversation with its own tools/prompt exactly the way every
 * `agent()` does.
 *
 * `budget` is the one field that adds something a bare `agent()` config
 * doesn't already give you ergonomically: a first-class per-task
 * cost/token cap. When set, the spawn runs under a `budget` middleware
 * that aborts the moment a cap is crossed, so a delegated subtask cannot
 * overrun its allowance. (Equivalent to passing
 * `middleware: [budget(...)]` to a plain agent — this just promotes it to
 * a spec field.) Distinct from `maxTrips`, which caps round-trips, not spend.
 */
export type SpawnSubAgentSpec<TOutput = unknown> = {
  /** Stable identifier for the spawned agent. */
  name: string;
  /** The model the sub-agent runs against. */
  model: ModelContract;
  /** The subtask instruction handed to the sub-agent's `execute()`. */
  task: string;
  /** Optional system prompt scoping the sub-agent's behavior. */
  systemPrompt?: SystemPromptContract | string;
  /** Tools the spawned agent may call inside its own loop (a fresh agent, so not shared with the caller). */
  tools?: AgentToolEntry<unknown, unknown>[];
  /** Per-spawn round-trip cap. Forwarded to the agent. Defaults to the agent default. */
  maxTrips?: number;
  /**
   * Per-task budget. When set, the spawn runs under a `budget` middleware
   * that aborts once a cap (`maxTokens` / `maxCostUSD`) is crossed — a
   * spend ceiling scoped to this one subtask. Because each spawn is its
   * own `agent()` instance, that ledger starts fresh per spawn.
   */
  budget?: BudgetOptions;
  /** Structured-output schema validated into `result.data`. */
  output?: StandardSchemaV1<TOutput>;
  /** Cancellation handle threaded into the sub-agent run. */
  signal?: AbortSignal;
  /**
   * Session identifier propagated onto the sub-agent's report tree so
   * the spawned run groups under the parent's session in flat trace
   * queries.
   */
  sessionId?: string;
};

/**
 * Build a fresh agent, run a single subtask through it once, and return
 * the unified {@link AgentResult}. Equivalent to
 * `agent({ ...spec, middleware: spec.budget && [budget(spec.budget)] }).execute(spec.task, { output, signal, sessionId })`.
 *
 * **Role.** A general-purpose "build, run, discard" primitive: a caller
 * (an agent tool, a workflow step, a planner step, a route callback, or
 * hand-rolled orchestration) hands a self-contained subtask to a
 * single-use agent created just for it, instead of reusing a long-lived
 * agent. The spawned `report` slots under the caller's
 * `report.children[]` like any executable, so cost and traces roll up
 * uniformly. It is not tied to any one primitive — it depends only on
 * `agent()` and the optional `budget` middleware.
 *
 * **What it is NOT.** Not a sandbox or a separate runtime. Each spawn is
 * a plain new `agent()` — its fresh conversation, own tools, and own
 * middleware state are ordinary new-instance behavior, not special
 * isolation (every `agent()` already has them). It is also a *narrower*
 * surface than `agent.execute`: one-shot, with no `history`,
 * `placeholders`, per-call event handlers, or `repair`. Reach for it when
 * you want a named single-use delegation with a per-task budget cap;
 * otherwise just construct an `agent()` and call it.
 *
 * Never throws on runtime failure — the agent surfaces failures on
 * `result.error` and a `"failed"` / `"cancelled"` report status.
 *
 * @example
 * const result = await spawnSubAgent({
 *   name: "extract-entities",
 *   model,
 *   task: "Pull every company name from this article: ...",
 *   budget: { maxCostUSD: 0.05 },
 *   output: z.object({ companies: z.array(z.string()) }),
 * });
 */
export async function spawnSubAgent<TOutput = unknown>(
  spec: SpawnSubAgentSpec<TOutput>,
): Promise<AgentResult<TOutput>> {
  const subAgent = buildSubAgent<TOutput>(spec);

  const options: AgentExecuteOptions<TOutput> = {};

  if (spec.output !== undefined) {
    options.output = spec.output;
  }

  if (spec.signal !== undefined) {
    options.signal = spec.signal;
  }

  if (spec.sessionId !== undefined) {
    options.sessionId = spec.sessionId;
  }

  return subAgent.execute(spec.task, options);
}

/**
 * Construct the fresh agent for one spawn. Attaches a `budget`
 * middleware only when a cap was requested, so the common no-budget case
 * is just a plain agent.
 */
function buildSubAgent<TOutput>(spec: SpawnSubAgentSpec<TOutput>): AgentContract<TOutput> {
  const middleware = spec.budget !== undefined ? [budget(spec.budget)] : undefined;

  return agent<TOutput>({
    name: spec.name,
    model: spec.model,
    systemPrompt: spec.systemPrompt,
    tools: spec.tools,
    maxTrips: spec.maxTrips,
    output: spec.output,
    middleware,
  });
}
