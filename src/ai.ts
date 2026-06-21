import { agent } from "./agent/agent";
import { batch } from "./batch";
import {
  checkpointMemory,
  checkpointPg,
  checkpointRedis,
} from "./checkpoint";
import { setAIConfig } from "./config";
import { evalScorers } from "./eval";
import { budget, readBudgetFallbackSignal } from "./middleware/builtins/budget";
import { memory } from "./memory";
import { guardrail } from "./middleware/builtins/guardrail";
import { semanticCache } from "./middleware/builtins/semantic-cache";
import { composeMiddleware, forTool } from "./middleware/helpers";
import { mockRouter } from "./mock";
import { fallbackModel } from "./model";
import { orchestrator } from "./orchestrator";
import { planner } from "./planner";
import { spawnSubAgent } from "./agent/spawn-sub-agent";
import { snapshotMemory, snapshotPg, snapshotRedis } from "./snapshot";
import { fanOut, router } from "./supervisor";
import { supervisor } from "./supervisor/supervisor";
import { instruction } from "./system-prompt/instruction";
import { persona } from "./system-prompt/persona";
import { systemPrompt } from "./system-prompt/system-prompt";
import { tool } from "./tool/tool";
import { step } from "./workflow/step";
import { workflow } from "./workflow/workflow";

/**
 * Top-level `ai` namespace — holds built-in factories and user-registered SDK adapters.
 *
 * Factories:
 * - `ai.tool(...)` — wrap an async function with a schema-validated input.
 * - `ai.agent(...)` — build an executable agent from model + tools + prompt.
 * - `ai.systemPrompt(...)` — compose a layered persona + instructions prompt.
 * - `ai.persona(text)` — reusable persona block (can be passed to `systemPrompt`).
 * - `ai.instruction(text)` — reusable instruction block (can be passed to `systemPrompt`).
 * - `ai.orchestrator(...)` — session-state manager wrapped around a supervisor (durable session, drift detection, resume, commands).
 * - `ai.memory(...)` — build an agent-memory store with WORKING (in-run scratch) and SEMANTIC (cache-driver `.similar()` recall) tiers.
 * - `ai.planner(...)` — build an executable that generates an ordered plan over registered capabilities, then runs it step-by-step.
 * - `ai.spawnSubAgent(spec)` — thin wrapper that builds a fresh one-shot `agent()` with an optional per-task `budget` and runs the task once. A general primitive (not planner-specific).
 * - `ai.router(...)` — build a supervisor-compatible routing agent from named intents.
 * - `ai.fanOut(unit, count)` — spread one agent/workflow into N intent entries for voting / self-consistency.
 * - `ai.batch(executable, items, opts?)` — run any executable over a dataset with bounded concurrency + per-item retry.
 * - `ai.fallbackModel(models, opts?)` — wrap an ordered model list that fails over to the next on transient provider errors.
 * - `ai.eval.{exact,contains,predicate,judge}(...)` — built-in scorer factories for `agent.eval(...)`.
 * - `ai.mockRouter(decisions, opts?)` — deterministic supervisor `route` callback for tests.
 * - `ai.checkpoint.{memory,pg,redis}()` — durable orchestrator session checkpoint stores.
 * - `ai.snapshot.{memory,pg,redis}()` — supervisor-run snapshot stores for `iterate: true` resume.
 * - `ai.openai.model(...)` / `ai.anthropic.model(...)` / ... once the adapter SDK is registered.
 *
 * @example
 * const alex = ai.persona("You are Alex, a TypeScript expert.");
 * const replyIn = ai.instruction("Respond in {{language|English}}.");
 *
 * const prompt = ai.systemPrompt().persona(alex).instruction(replyIn);
 *
 * const myAgent = ai.agent({
 *   model: ai.openai.model({ name: "gpt-4o" }),
 *   systemPrompt: prompt,
 *   tools: [myTool],
 * });
 *
 * const result = await myAgent.execute("What is the weather in Cairo?", {
 *   placeholders: { language: "Arabic" },
 * });
 */
export const ai = {
  config: setAIConfig,
  tool,
  agent,
  systemPrompt,
  persona,
  instruction,
  workflow,
  step,
  supervisor,
  orchestrator,
  memory,
  planner,
  spawnSubAgent,
  router,
  fanOut,
  batch,
  fallbackModel,
  eval: evalScorers,
  mockRouter,
  middleware: {
    budget,
    guardrail,
    semanticCache,
    compose: composeMiddleware,
    forTool,
    readBudgetFallbackSignal,
  },
  checkpoint: {
    memory: checkpointMemory,
    pg: checkpointPg,
    redis: checkpointRedis,
  },
  snapshot: {
    memory: snapshotMemory,
    pg: snapshotPg,
    redis: snapshotRedis,
  },
};
