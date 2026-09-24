---
name: define-ai-tool
description: 'Define tools with ai.tool({...}) — typed validated async functions the model can call. Covers name / description / action / mode (feedback / silent) / input / execute, `ctx.artifacts` side-channel, `ToolExecutionError`. Triggers: `ai.tool`, `ToolContract`, `ToolContext`, `ToolCall`, `ToolExecutionError`, `artifactsSchema`, `mode: "silent"`, `workflow.asTool`; ''define a tool'', ''wire tool into agent'', ''tool input validation'', ''side-channel artifacts''; typical import `import { ai } from "@warlock.js/ai"`. Skip: agent loop — `@warlock.js/ai/run-ai-agent/SKILL.md`; supervisor artifacts — `@warlock.js/ai/run-supervisor/SKILL.md`; competing libs `langchain` tools, raw `openai` function-calling.'
---

# `ai.tool()` — typed tool factory

Tools are async functions the model can call by name during a trip loop. Define one with `ai.tool()`, pass it in `agent({ tools: [...] })`, and the agent handles dispatch, input validation, and error surfacing automatically.

## Factory shape

```ts
ai.tool({
  name: string,                                 // stable identifier
  description: string,                          // sent to the model
  version?: string,                             // mirrored onto tool reports
  action?: string | ((input: TInput) => string), // UI label for streaming UX
  mode?: "feedback" | "silent",                 // result feedback control
  input: StandardSchemaV1<TInput>,              // validated before execute
  execute: (input: TInput, ctx?: ToolContext) => Promise<unknown>,
});
```

Returns a `ToolContract<TInput, TOutput>`. One tool can be attached to many agents.

## `description` vs `action`

Two roles, two fields:

- **`description`** — what the LLM reads when deciding whether to call this tool.
- **`action`** — present-progressive UI string surfaced to humans on `agent.tool.calling` / `agent.tool.called` events.

```ts
ai.tool({
  name: "search_catalog",
  description: "Search the product catalog. Returns matching products with SKU, name, price.",
  action: ({ query }) => `Searching the catalog for "${query}"`,
  input: v.object({ query: v.string() }),
  execute: async ({ query }) => searchProducts(query),
});
```

Two forms supported: static string or function. Function form runs after input validation; throws are swallowed (UI strings aren't worth aborting LLM dispatch over).

## Schema via Standard Schema V1

Input is typed as `StandardSchemaV1<T>`. Recommended: `@warlock.js/seal`. Zod / Valibot / hand-rolled all interop.

```ts
import { v } from "@warlock.js/seal";

const searchTool = ai.tool({
  name: "search",
  description: "Search the docs index",
  input: v.object({
    query: v.string(),
    limit: v.number().optional(),
  }),
  execute: async ({ query, limit }) => fetchDocs(query, limit ?? 10),
});
```

## Input validation is automatic

The agent calls `input["~standard"].validate(rawArgs)` before invoking `execute`. Validation failures **do not throw** — the failure is recorded on the trip's `ToolCall.error` and fed back to the model on the next trip as a tool error message. The model gets a chance to correct and retry within the bounded `maxTrips` loop.

## What gets returned to the model

Whatever your `execute` resolves with is `JSON.stringify`'d and sent back as the next trip's `tool` message. Strings pass through unchanged. Throw (or return a rejected promise) to signal failure — the agent records the error on `ToolCall.error` and tells the model.

## `mode` — feedback vs silent

Default `"feedback"`.

- **`mode: "feedback"`** (default) — standard round-trip. Result feeds back into next trip; the model reads it and replies. Use for tools whose output the model needs to narrate: `search_catalog`, `search_knowledge_base`, `ask_questions`.
- **`mode: "silent"`** — fire-and-forget. Result NOT fed back to the model. When EVERY tool call in a single generation is silent, the agent loop terminates after dispatch. Use for pure side-effect tools: `update_state`, `set_locale`, telemetry pings.

```ts
ai.tool({
  name: "update_state",
  description: "Persist customer slot-fill across turns.",
  mode: "silent",
  input: v.object({ preferences: v.array(v.string()).optional() }),
  execute: async (patch, ctx) => {
    ctx.artifacts.stateUpdate = patch;
    return { ok: true };  // model never sees this
  },
});
```

**All-silent rule.** The loop terminates only when EVERY tool call this trip is silent. Silent + feedback in the same generation → loop continues (the feedback tool still round-trips, the silent one piggybacks).

**Constraints for silent tools.** MUST be cheap + fast (HTTP request still open until dispatch resolves), should be idempotent (no surface to communicate failure to the model), side-effect-only.

## Tool context — `ctx.artifacts` side-channel

`execute` accepts an optional **second argument** — a `ToolContext` with a mutable `artifacts` bag and the dispatch's `signal`. Use it to capture system-only data (renderable blocks, citations, files, telemetry, soft signals) that the LLM should NOT see.

```ts
ai.tool({
  name: "search_catalog",
  input: v.object({ query: v.string() }),
  execute: async (input, ctx) => {
    const items = await searchItems(input.query);

    // Side-channel — never reaches the LLM.
    ctx.artifacts.blocks ??= [];
    ctx.artifacts.blocks.push({ type: "items", itemIds: items.map(i => i.id) });

    // LLM-visible — what the agent reasons over.
    return { total: items.length };
  },
});
```

Under a supervisor: bag starts empty per iteration, accumulates writes from all tool calls, merges into state at iteration end (auto-spread by default; `finalizeArtifacts` for concat / dedupe). See [`@warlock.js/ai/run-supervisor/SKILL.md`](@warlock.js/ai/run-supervisor/SKILL.md).

Standalone (no supervisor): framework supplies `{ artifacts: {} }`. Mutations are harmless no-ops.

## Type contract for artifacts

The supervisor declares an `artifactsSchema`; tools registered to it inherit typed `ctx.artifacts.*`. Standalone tools fall back to `Record<string, unknown>`.

```ts
ai.supervisor({
  artifactsSchema: v.object({
    blocks: v.array(blockSchema).optional(),
    citations: v.array(citationSchema).optional(),
  }),
  // tools see ctx.artifacts typed as { blocks?, citations? }
});
```

## Error categorization

`invoke()` never throws — failures surface on the returned `error` field, and the agent records them on the dispatch's `ToolCall.error`. The error class depends on what failed:

- **Input schema rejected the model's args** → `SchemaValidationError` (`code: "SCHEMA_VALIDATION_FAILED"`), `issues` preserved. NOT wrapped in `ToolExecutionError`.
- **Schema's own `validate()` threw** → `SchemaValidationError` wrapping the cause.
- **Your `execute()` threw** → `ToolExecutionError` (`code: "TOOL_EXEC_FAILED"`, category `tool`) with `toolName`, and the thrown value on `error.cause`.

`ToolExecutionError` carries `toolName` always; `tripIndex` is stamped by the agent that dispatched it. The validation failure is fed back to the model on the next trip so it can correct within the `maxTrips` loop.

See [`@warlock.js/ai/handle-ai-errors/SKILL.md`](@warlock.js/ai/handle-ai-errors/SKILL.md).

## Inspecting tool calls

```ts
const result = await myAgent.execute("Pick a city and tell me the weather.");

const toolCalls = result.report.children.filter((c) => c.type === "tool");

for (const call of toolCalls) {
  console.log(call.tripIndex, call.name, call.input, call.output, call.duration);
}
```

Tool dispatches are child `BaseReport` nodes on `report.children` (not a separate `report.toolCalls` field) — filter by `c.type === "tool"`. Each `ToolCall` is a `BaseReport & { type: "tool", tripIndex, input, output?, error? }`, so it carries `name` / `startedAt` / `endedAt` / `duration` from the report base.

## Events

- `agent.tool.calling` — `{ tool, input, tripIndex }`
- `agent.tool.called` — `ToolCall & { tool }` (full record)
- `agent.tool.failed` — `{ tool, input, error, tripIndex }`

Subscribe at factory / instance / per-call.

## Pattern — workflow as a tool

```ts
const wrapped = myWorkflow.asTool({
  description: "Run the catalog ingestion workflow",
  inputSchema: v.object({ url: v.string() }),
});

const agent = ai.agent({ model, tools: [wrapped] });
```

Workflow errors surface as `ToolExecutionError` with `cause` pointing at the original `WorkflowError` subclass.

## See also

- [`@warlock.js/ai/run-ai-agent/SKILL.md`](@warlock.js/ai/run-ai-agent/SKILL.md) — how tools plug into the trip loop
- [`@warlock.js/ai/handle-ai-errors/SKILL.md`](@warlock.js/ai/handle-ai-errors/SKILL.md) — error hierarchy
- [`@warlock.js/ai/run-supervisor/SKILL.md`](@warlock.js/ai/run-supervisor/SKILL.md) — artifacts under a supervisor
- [`@warlock.js/ai/run-ai-workflow/SKILL.md`](@warlock.js/ai/run-ai-workflow/SKILL.md) — `workflow.asTool()` composition
