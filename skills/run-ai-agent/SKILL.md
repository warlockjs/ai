---
name: run-ai-agent
description: 'Build agents with ai.agent({...}) — the single-LLM-turn primitive. Covers execute / stream, attachments, structured output, placeholders, events, agent.eval scoring, the judge-safe preset for resilient LLM-as-judge / verdict classifiers (ai.agent.judge / judge: true — lenient JSON parse + repair + never-throw, for Nova-class models), and auto-adapting raw executables in tools:[]. Triggers: `ai.agent`, `ai.agent.judge`, `agent.execute`, `agent.stream`, `agent.eval`, `AgentResult`, `AgentReport`, `AgentToolEntry`, `JudgeConfig`, `JudgeAgentConfig`, `judge`, `repairAttempts`, `streamingToolGuard`, `attachments`, `repair`, `maxTrips`, `sessionId`, `spawnSubAgent`, `SpawnSubAgentSpec`; ''run an agent'', ''stream an agent response'', ''structured output schema'', ''pass image to agent'', ''evaluate an agent'', ''LLM-as-judge that survives malformed JSON'', ''grade with a Nova model without crashing'', ''put a supervisor in tools'', ''cancel an agent run'', ''spawn a one-shot sub-agent with a per-task budget''; typical import `import { ai } from "@warlock.js/ai"`. Skip: tool definition — `@warlock.js/ai/define-ai-tool/SKILL.md`; workflows — `@warlock.js/ai/run-ai-workflow/SKILL.md`; eval matchers / batch / fallback detail — `@warlock.js/ai/ai-dx-helpers/SKILL.md`; competing libs `langchain`, `ai` (Vercel), raw `openai`.'
---

# `ai.agent()` — single-turn primitive

The lowest rung of the 4-primitive ladder. One LLM call, optional tool loop, optional structured output. Stateless across calls.

## Factory shape

```ts
import { ai } from "@warlock.js/ai";
import { OpenAISDK } from "@warlock.js/ai-openai";

const openai = new OpenAISDK({ apiKey: process.env.OPENAI_API_KEY! });

ai.agent({
  name?: string,                              // optional — anonymous gets a fingerprint
  model: openai.model({ name: "gpt-4o-mini" }),
  systemPrompt?: string | SystemPromptContract,
  tools?: AgentToolEntry<any, any>[],          // ToolContract OR a raw executable (auto-adapted)
  placeholders?: Record<string, unknown>,
  maxTrips?: number,                           // default 10
  modelOptions?: ModelCallOptions,
  output?: StandardSchemaV1<T>,                // default structured-output schema
  middleware?: AgentMiddleware[],
  streamingToolGuard?: StreamingToolGuardConfig, // opt-in tool-call recovery from text leaks
  on?: AgentEventHandlers,
  version?: string,                            // mirrored onto reports for trip archives
});
```

The factory returns an `AgentContract<TOutput>`. Every execution spawns a fresh internal `Execution` — the factory holds no per-call state.

## Anonymous agents

`name` is optional. Anonymous agents receive a deterministic fingerprint:

```
anon_<provider>_<model>[_<tool1>+<tool2>+...]
```

Same config across process restarts → same synthetic name. Keeps workflow signature drift detection honest when you compose anonymous agents into a workflow.

## Execute surface

```ts
agent.execute(input: string, options?: AgentExecuteOptions): Promise<AgentResult<T>>;
agent.stream(input: string, options?: AgentExecuteOptions): StreamContract<AgentResult<T>>;
```

`AgentExecuteOptions` — every field optional:

```ts
{
  history?: Message[];
  attachments?: Attachment[];                    // images today; PDFs later
  placeholders?: Record<string, unknown>;
  output?: StandardSchemaV1<T>;                  // typed structured output → result.data
  responseSchema?: Record<string, unknown>;      // hand-crafted JSON Schema escape hatch
  systemPrompt?: SystemPromptContract;           // per-call override
  repair?: { maxAttempts?: number };             // opt-in re-ask on validation failure
  signal?: AbortSignal;                          // cancellation
  sessionId?: string;                            // stitch many runs into one session
  streamingToolGuard?: StreamingToolGuardConfig;
  on?: AgentEventHandlers;
}
```

## `streamingToolGuard` — recover tool calls leaked as text

Cheap and fast models occasionally emit a registered tool's structured input as **literal text in the content stream** instead of as a real `tool_call`. Without intervention, customers watch raw JSON build character-by-character.

```ts
ai.agent({
  model: someFastModel,
  tools: [suggestFollowupsTool, searchCatalogTool],
  streamingToolGuard: {},  // empty object = on with defaults
});
```

Recovery conditions: the buffered JSON must (a) parse cleanly, (b) carry a `name` or `tool` key resolving to a registered tool, AND (c) carry an `arguments` or `input` key whose value validates against that tool's input schema. Anything else flushes back as text — the guard never invents calls.

**Off by default.** Set this explicitly on agents whose registered tools have been observed to leak.

## `sessionId` — stitch many runs into one user session

```ts
const sessionId = "sess_user_42_2026-05-12";
await agent.execute("what's my order?", { sessionId });
await agent.execute("cancel it", { sessionId });   // 30 seconds later, same session
```

The framework stamps it onto every report node this run produces. Cost dashboards can group by `sessionId` without joining the report tree.

## Result shape — `AgentResult<T>`

```ts
type AgentResult<T> = {
  type: "agent";
  data?: T;             // structured output when `output` schema was supplied
  text?: string;        // raw final LLM text
  report: AgentReport;  // trips, toolCalls, status, timing
  usage: Usage;         // aggregated token usage + cost breakdown
  error?: AIError;
};

type AgentReport = {
  runId: string;
  rootRunId: string;
  name: string;
  status: "completed" | "failed" | "cancelled";
  startedAt: string;
  endedAt: string;
  duration: number;
  model: { name: string; provider: string };
  trips: LLMTrip[];
  children: ToolCall[];   // tool dispatches — filter by `c.type === "tool"`
};
```

Tool calls are NOT a separate `report.toolCalls` field — every tool dispatch is a child `BaseReport` node (`type: "tool"`) on `report.children`. Filter the tree to isolate them:

```ts
const toolCalls = report.children.filter((c) => c.type === "tool");
const nestedAgents = report.children.filter((c) => c.type === "agent");
```

Canonical destructuring:

```ts
const { data, text, report, usage, error } = await agent.execute(input);

if (error) {
  logger.warn(error.code, { duration: report.duration, trips: report.trips.length });
  return;
}
```

## Pattern — structured output

```ts
import { v, type Infer } from "@warlock.js/seal";

const summarySchema = v.object({
  summary: v.string(),
  keyPoints: v.array(v.string()).min(1),
});

const result = await myAgent.execute(input, { output: summarySchema });

if (result.data) {
  // typed as Infer<typeof summarySchema>
}
```

Adapters with `capabilities.structuredOutput: true` forward the schema natively. Adapters without it get a soft "respond in JSON only" instruction. Client-side validation always runs.

## Pattern — output baked into the agent

```ts
const titleAgent = ai.agent({
  model: openai.model({ name: "gpt-4o-mini" }),
  output: titleSchema, // typed end-to-end via AgentContract<Infer<typeof titleSchema>>
  systemPrompt: "...",
});

const result = await titleAgent.execute(currentMessage, { history });
//    ^? AgentResult<{ title?: string }>
```

Call-site `options.output` fully **replaces** `config.output` for that run — no merging.

## Pattern — repair on validation failure

```ts
await myAgent.execute(input, {
  output: schema,
  repair: { maxAttempts: 1 }, // re-ask once on parse/validation failure
});
```

Disabled by default. Each repair attempt counts against `maxTrips`.

## `judge` preset — resilient LLM-as-judge / verdict classifiers

For graders and verdict classifiers running on models that emit **corrupted** structured output — notably the Amazon Nova family, which wraps verdicts in fenced ` ```json ` blocks, prepends prose, or trails commentary — set `judge: true` (or a `JudgeConfig`). It turns on three behaviors at once:

```ts
const grader = ai.agent.judge({
  model: nova.model({ name: "amazon.nova-pro-v1:0" }),
  systemPrompt: "Grade the answer. Respond with JSON only.",
  output: verdictSchema,
});

const result = await grader.execute(prompt);
if (result.error) {
  // graceful default — the judge couldn't produce a clean verdict
}
```

1. **Repair** — a couple of re-ask attempts by default (`repairAttempts`, defaults to `2`; bounded by `maxTrips`) when the verdict fails to parse / validate. The caller's per-call `options.repair` still wins.
2. **Lenient verdict parsing** — extracts the first balanced JSON object / array (tolerating fenced blocks + surrounding prose) instead of the strict parser.
3. **Never throws on a parse miss** — even an unparseable verdict yields a well-formed result (`result.error` populated, `result.data` undefined), so a flaky judge degrades instead of crashing the flow.

`ai.agent.judge(config, judge?)` is sugar for `ai.agent({ ...config, judge })`; the bare `ai.agent({ judge: true })` option does the same. `judge: {}` ≡ `judge: true` (every field falls back to its resilient default); `judge: { repairAttempts: 0 }` keeps the lenient parser + never-throw guarantee but disables repair.

**Trade-off — resilience over strictness.** The lenient parse can recover JSON the strict parser would (correctly) reject — leave `judge` **off** for normal structured output, where a hard parse failure is a useful signal. Off by default; omitting it parses strictly and never auto-enables repair, byte-for-byte as before. (This is the same Nova-safe judge the unified prompt `validate()` uses — see [`@warlock.js/ai/manage-prompts/SKILL.md`](@warlock.js/ai/manage-prompts/SKILL.md).)

## Pattern — image attachments

```ts
await myAgent.execute("What's in this?", {
  attachments: ["./photo.png", "https://cdn.example.com/cat.jpg"],
});
```

Shorthand strings infer the image kind from extension. Tagged form for explicit control:

```ts
attachments: [
  { type: "image", source: "./photo" },
  { type: "image", source: { base64: "...", mediaType: "image/png" } },
];
```

Model must declare `capabilities.vision`. OpenAI adapter auto-infers from name; override with `openai.model({ name, vision: true })`.

## Pattern — streaming

```ts
const stream = myAgent.stream(input);

for await (const event of stream) {
  if (event.type === "agent.trip.streaming") {
    process.stdout.write(event.delta);
  }
}

const result = await stream.result;
```

Or use `.on({ "agent.trip.streaming": ..., "agent.completed": ..., "agent.error": ... })` alongside iteration.

## Pattern — cancellation

```ts
const ctrl = new AbortController();
const resultPromise = myAgent.execute(input, { signal: ctrl.signal });

setTimeout(() => ctrl.abort("too slow"), 30_000);

const { error, report } = await resultPromise;
if (report.status === "cancelled") {
  // error is an AgentCancelledError (code "AGENT_CANCELLED",
  // category "cancelled") carrying `cancelledAt` + `reason`
}
```

Between-trip abort is guaranteed. Mid-trip best-effort.

## Events — dot-notation + 3-tier subscription

- `agent.starting`, `agent.trip.started`, `agent.trip.streaming`, `agent.trip.completed`
- `agent.tool.calling`, `agent.tool.called`, `agent.tool.failed`
- `agent.completed`, `agent.error`

Three subscription tiers — fire in order **factory → instance → per-call**:

```ts
ai.agent({ model, on: { "agent.starting": () => metrics.inc("agent.runs") } });

const unsubscribe = myAgent.on("agent.error", ({ error }) => logger.error(error));

await myAgent.execute("go", {
  on: { "agent.trip.completed": ({ trip }) => console.log(trip.duration) },
});
```

Every event payload carries `runId` and `rootRunId`. Same identity fields ride on stream events.

## `tools: []` — auto-adapt executables

Each `tools` entry is either a built `ToolContract` (from `ai.tool(...)` or an explicit `.asTool(...)`) OR a **raw executable primitive** (`AgentContract` / `WorkflowInstance` / `SupervisorContract` / orchestrator) — auto-adapted into a `ToolContract` at factory time. The manifest is derived from the executable's `name` + `description` + (optional) `inputSchema`; dispatch flows through its `execute()`.

```ts
const concierge = ai.agent({
  model,
  tools: [billingWorkflow, supportSupervisor, lookupTool],  // no .asTool() needed
});
```

`.asTool()` still works and takes precedence when you need a custom name / schema per use. A supervisor/orchestrator needs `inputSchema` on its config to drop straight into `tools: []`. See [`@warlock.js/ai/define-ai-tool/SKILL.md`](@warlock.js/ai/define-ai-tool/SKILL.md).

## `agent.eval(options)` — score the agent against a suite

```ts
const report = await myAgent.eval({
  cases: [
    { name: "capital", input: "Capital of Egypt?", expected: "Cairo" },
    { name: "tone", input: "Comfort an upset user." },          // judge-scored
  ],
  scorers: [ai.eval.contains()],                                 // default for cases w/o their own
  judge: { agent: judgeAgent, rubric: "Score 1.0 only if empathetic." },  // LLM-as-judge fallback
  passThreshold: 0.5,                                            // default
});

expect(report.passed).toBe(true);   // true only when EVERY case passed
```

Each case runs through `execute(input)`; scorer precedence is per-case `scorers` → suite `scorers` → synthesized `judge` (throws at author time if a case resolves none). Built-in scorers on `ai.eval.*`: `exact()`, `contains()`, `predicate(fn)`, `judge(config)`. Full coverage — plus the Vitest matchers (`registerAiMatchers` / `toRouteTo` / `toConverge` / `toPassStep` / `toOutputShape`) — in [`@warlock.js/ai/ai-dx-helpers/SKILL.md`](@warlock.js/ai/ai-dx-helpers/SKILL.md).

## `ai.spawnSubAgent()` — one-shot delegation with a budget

`ai.spawnSubAgent(spec)` is a thin wrapper over this same `ai.agent()`: it builds a fresh agent from the spec, optionally attaches a `budget` middleware, runs the `task` once, and returns the `AgentResult`. Not a sandbox or a separate runtime — a spawn is an ordinary new agent (empty conversation, its own tools/prompt). It is a **general** primitive: usable inside a tool, a workflow or planner step, a supervisor intent, or hand-rolled orchestration — it is NOT planner-specific (the planner engine never calls it).

```ts
import { ai } from "@warlock.js/ai";

const result = await ai.spawnSubAgent({
  name: "extract-entities",
  model,
  task: "Pull every company name from this article: ...",
  budget: { maxCostUSD: 0.05 },   // per-task spend cap — aborts when crossed
  output: companiesSchema,
});
```

The one field a bare agent config doesn't surface ergonomically is `budget` (`BudgetOptions` — `maxTokens` / `maxCostUSD`), equivalent to `ai.agent({ middleware: [ai.middleware.budget(...)] })` but promoted to a first-class spec field so a delegated subtask can't overrun its cap (distinct from `maxTrips`, which caps round-trips, not spend). The surface is **narrower** than `agent.execute()`: one-shot, with no `history`, `placeholders`, per-call events, or `repair`. The spawned `report` slots under the caller's `report.children[]`, so cost and traces roll up uniformly. Reach for it when you want a named single-use delegation with a hard spend cap; otherwise just build an `ai.agent()` and call it.

## When NOT to use this primitive

- Multi-step pipeline with a fixed shape → [`@warlock.js/ai/run-ai-workflow/SKILL.md`](@warlock.js/ai/run-ai-workflow/SKILL.md)
- Multi-agent routing with iteration → [`@warlock.js/ai/run-supervisor/SKILL.md`](@warlock.js/ai/run-supervisor/SKILL.md)

## See also

- [`@warlock.js/ai/define-ai-tool/SKILL.md`](@warlock.js/ai/define-ai-tool/SKILL.md) — tool wiring + schema validation
- [`@warlock.js/ai/write-system-prompt/SKILL.md`](@warlock.js/ai/write-system-prompt/SKILL.md) — persona / instruction builders
- [`@warlock.js/ai/handle-ai-errors/SKILL.md`](@warlock.js/ai/handle-ai-errors/SKILL.md) — `AIError` hierarchy
