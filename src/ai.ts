import { agent } from "./agent/agent";
import { batch } from "./batch";
import { streamObject } from "./object-stream";
import { serve } from "./serve";
import {
  checkpointMemory,
  checkpointPg,
  checkpointRedis,
} from "./checkpoint";
import { setAIConfig } from "./config";
import { dataset, evalScorers } from "./eval";
import { humanApproval } from "./human/human-approval";
import { human } from "./human/register";
import { image } from "./image";
import { speech } from "./speech";
import {
  audioFromBuffer,
  audioFromFile,
  audioMediaTypeForFilename,
  transcribe,
} from "./transcribe";
import { resume } from "./human/resume";
import {
  interruptMemory,
  interruptPg,
  interruptRedis,
} from "./human/stores";
import { guardrail as guardrailSuite } from "./guard/guardrail";
import { budget, readBudgetFallbackSignal } from "./middleware/builtins/budget";
import { memory } from "./memory";
import { guardrail } from "./middleware/builtins/guardrail";
import { semanticCache } from "./middleware/builtins/semantic-cache";
import { composeMiddleware, forTool } from "./middleware/helpers";
import { mockRouter } from "./mock";
import { fallbackModel } from "./model";
import { orchestrator } from "./orchestrator";
import { planner } from "./planner";
import { defaultPromptsManager } from "./prompts/prompts-manager";
import {
  bm25Rank,
  cacheVectorStore,
  chunk,
  hybridRank,
  keywordReranker,
  llmReranker,
  loadHtml,
  loadPdf,
  loadText,
  loadWeb,
  multiQuery,
  pgVectorStore,
  rag,
  reciprocalRankFusion,
  vectorLiteral,
} from "./rag";
import { spawnSubAgent } from "./agent/spawn-sub-agent";
import { skills } from "./skills";
import { prompt } from "./prompt";
import { vcr } from "./vcr";
import { snapshotMemory, snapshotPg, snapshotRedis } from "./snapshot";
import { fanOut, router } from "./supervisor";
import { supervisor } from "./supervisor/supervisor";
import { team } from "./team/team";
import { instruction } from "./system-prompt/instruction";
import { persona } from "./system-prompt/persona";
import { systemPrompt } from "./system-prompt/system-prompt";
import { tool } from "./tool/tool";
import { step } from "./workflow/step";
import { workflow } from "./workflow/workflow";

/**
 * The shape of the top-level `ai` namespace. Declared as an `interface` (not an
 * inferred `const` type) so satellite packages can attach their verb via
 * `declare module "@warlock.js/ai" { interface Ai { … } }` — e.g. `ai.workspace`,
 * `ai.tools`, `ai.mcp`, `ai.human`. The runtime object below is asserted to this
 * type; a satellite assigns its member on import.
 */
export interface Ai {
  config: typeof setAIConfig;
  tool: typeof tool;
  agent: typeof agent;
  systemPrompt: typeof systemPrompt;
  persona: typeof persona;
  instruction: typeof instruction;
  workflow: typeof workflow;
  step: typeof step;
  supervisor: typeof supervisor;
  team: typeof team;
  orchestrator: typeof orchestrator;
  memory: typeof memory;
  skills: typeof skills;
  planner: typeof planner;
  rag: typeof rag & {
    keywordReranker: typeof keywordReranker;
    llmReranker: typeof llmReranker;
    chunk: typeof chunk;
    cacheVectorStore: typeof cacheVectorStore;
    pgVectorStore: typeof pgVectorStore;
    vectorLiteral: typeof vectorLiteral;
    loadText: typeof loadText;
    loadHtml: typeof loadHtml;
    loadWeb: typeof loadWeb;
    loadPdf: typeof loadPdf;
    bm25Rank: typeof bm25Rank;
    reciprocalRankFusion: typeof reciprocalRankFusion;
    hybridRank: typeof hybridRank;
    multiQuery: typeof multiQuery;
  };
  spawnSubAgent: typeof spawnSubAgent;
  router: typeof router;
  fanOut: typeof fanOut;
  batch: typeof batch;
  /** Structured-output streaming — partial-object snapshots + a strict final parse (A1). */
  streamObject: typeof streamObject;
  /** Serve an executable as an SSE HTTP endpoint — production serving primitive (A3). */
  serve: typeof serve;
  /**
   * Generate images from a text prompt — the image-output verb of the
   * output-modality track (Theme I). Wraps an `ImageModelContract` (from
   * `openai.image(...)` / `google.image(...)`) in the uniform
   * never-throws `{ data, error, usage, report }` envelope with cost-truth
   * and observability.
   */
  image: typeof image;
  /** Text-to-speech (TTS) — the audio-output verb of the modality track (Theme I). */
  speech: typeof speech;
  /** Speech-to-text (STT / transcription) — the audio-input verb of the modality track (Theme I). */
  transcribe: typeof transcribe;
  /** Read an audio file from disk → `AudioInput` for `ai.transcribe` (non-AI file plumbing). */
  audioFromFile: typeof audioFromFile;
  /** Package raw audio bytes → `AudioInput` for `ai.transcribe`. */
  audioFromBuffer: typeof audioFromBuffer;
  /** Resolve the audio media type from a filename's extension. */
  audioMediaTypeForFilename: typeof audioMediaTypeForFilename;
  fallbackModel: typeof fallbackModel;
  eval: typeof evalScorers;
  dataset: typeof dataset;
  prompt: typeof prompt;
  /**
   * Process-wide registry of named, versioned `systemPrompt(...)` builders,
   * keyed by `name@version`. A `systemPrompt(input, { name })` (or any
   * `.meta({ name })` rename) auto-registers here; `ai.prompts.get(name)` /
   * `.resolve(name)` reads them back, and `systemPrompt().merge(name)` folds a
   * registered prompt into a new one.
   */
  prompts: ReturnType<typeof defaultPromptsManager>;
  vcr: typeof vcr;
  mockRouter: typeof mockRouter;
  middleware: {
    budget: typeof budget;
    guardrail: typeof guardrail;
    semanticCache: typeof semanticCache;
    compose: typeof composeMiddleware;
    forTool: typeof forTool;
    readBudgetFallbackSignal: typeof readBudgetFallbackSignal;
  };
  checkpoint: {
    memory: typeof checkpointMemory;
    pg: typeof checkpointPg;
    redis: typeof checkpointRedis;
  };
  snapshot: {
    memory: typeof snapshotMemory;
    pg: typeof snapshotPg;
    redis: typeof snapshotRedis;
  };
  /**
   * Human-in-the-loop tool approval (interrupt / resume).
   *
   * - `human.approval(options)` — the `tool.before` approval-gate middleware.
   * - `human.resume(id, decision, options)` — out-of-process durable resume.
   * - `human.interrupt.{memory,pg,redis}()` — durable {@link InterruptStore}
   *   factories (memory ships real; pg/redis are lazy optional peers).
   */
  human: {
    approval: typeof humanApproval;
    resume: typeof resume;
    interrupt: {
      memory: typeof interruptMemory;
      pg: typeof interruptPg;
      redis: typeof interruptRedis;
    };
  };
  /**
   * Content-intelligence guardrail. `ai.guardrail(options)` builds a composed
   * input / output / tool middleware; `ai.guardrail.{pii,topic,injection,moderation}`
   * are the built-in detector factories.
   */
  guardrail: typeof guardrailSuite;
}

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
 * - `ai.skills(...)` — build a runtime skills library (always-injected metadata catalog + on-demand loadSkill tool).
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
 * - `ai.human.approval(...)` / `ai.human.resume(...)` / `ai.human.interrupt.{memory,pg,redis}()` — human-in-the-loop tool approval (interrupt / resume).
 * - `ai.guardrail(options)` + `ai.guardrail.{pii,topic,injection,moderation}(...)` — content-intelligence guardrails (moderation / PII / injection / topic).
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
  team,
  orchestrator,
  memory,
  skills,
  planner,
  rag: Object.assign(rag, {
    keywordReranker,
    llmReranker,
    chunk,
    cacheVectorStore,
    pgVectorStore,
    vectorLiteral,
    loadText,
    loadHtml,
    loadWeb,
    loadPdf,
    bm25Rank,
    reciprocalRankFusion,
    hybridRank,
    multiQuery,
  }),
  spawnSubAgent,
  router,
  fanOut,
  batch,
  streamObject,
  serve,
  image,
  speech,
  transcribe,
  audioFromFile,
  audioFromBuffer,
  audioMediaTypeForFilename,
  fallbackModel,
  eval: evalScorers,
  dataset,
  prompt,
  prompts: defaultPromptsManager(),
  vcr,
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
  human,
  guardrail: guardrailSuite,
  // Asserted (not `: Ai`) so a consumer build that augments `Ai` with a
  // satellite verb (e.g. `workspace`) doesn't flag this literal as missing it.
} as Ai;
