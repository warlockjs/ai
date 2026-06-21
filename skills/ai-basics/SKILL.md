---
name: ai-basics
description: 'Start with @warlock.js/ai — provider-agnostic core for agents / tools / workflows / supervisors / orchestrators. 4-primitive ladder (agent → workflow → supervisor → orchestrator, all shipped) plus planner, memory, stores, DX helpers, and the optional @warlock.js/ai-panoptic observability sidecar. Every primitive returns {data, error, usage, report}. Triggers: `ai.agent`, `ai.tool`, `ai.workflow`, `ai.supervisor`, `ai.orchestrator`, `ai.planner`, `ai.memory`, `ai.systemPrompt`, `ExecuteResult`, `BaseReport`, `AIError`, `panoptic`; ''which AI primitive do I use'', ''what is warlock ai'', ''pick an AI skill'', ''how do I observe / trace AI runs''; typical import `import { ai } from "@warlock.js/ai"`. Skip: agent details — `@warlock.js/ai/run-ai-agent/SKILL.md`; competing libs `langchain`, `llamaindex`, `ai` (Vercel SDK); raw `openai` / `@anthropic-ai/sdk`.'
---

# AI foundations

Provider-agnostic core for building AI primitives in TypeScript. Adapters live in sibling packages — all five first-party adapters ship today: `@warlock.js/ai-openai`, `-anthropic`, `-bedrock`, `-google`, `-ollama`.

> This skill is the AI **map** — read it first, then load the specific skill for the task.

## The 4-primitive ladder

```
ai.agent()        →  single task, stateless                    [shipped]
ai.workflow()     →  static predefined steps, resumable        [shipped]
ai.supervisor()   →  multi-agent dynamic routing, resumable    [shipped]
ai.orchestrator() →  durable session — state/history/resume    [shipped]
```

Each primitive is an escape hatch to the next level of complexity. Users start low, graduate upward only when needed. Every primitive returns the same result envelope — canonical destructure `{ data, error, usage, report }` (the shared `BaseResult` guarantees `usage` + optional `error`; each primitive adds `data` + `report`). Workflows, supervisors, and orchestrators expose `.asTool()` so an agent can call them inside its tool loop; raw executables also auto-adapt when dropped into an agent's `tools: []`. Compose freely.

Beyond the ladder: `ai.planner()` (LLM-generated plans), `ai.memory()` (working + semantic recall), `ai.batch()` / `ai.fallbackModel()` / `ai.router()` / `ai.fanOut()` (DX helpers), `agent.eval()` (scoring), and the `ai.checkpoint.*` / `ai.snapshot.*` orchestrator stores.

## Foundations

1. **Public API is functional factories.** Use `ai.agent({...})`, `ai.tool({...})`, `ai.workflow({...})`, `ai.step({...})`, `ai.supervisor({...})`, `ai.systemPrompt()`, `ai.persona()`, `ai.instruction()`. Never `new Agent()`.
2. **Adapter entry points are classes.** `new OpenAISDK({ apiKey })` from [`@warlock.js/ai-openai/setup-openai/SKILL.md`](@warlock.js/ai-openai/setup-openai/SKILL.md).
3. **Schemas everywhere are `StandardSchemaV1<T>`.** Recommended: [`@warlock.js/seal`](@warlock.js/seal/seal-basics/SKILL.md) — `v.object({...})`. Zod, Valibot, hand-rolled all interop.
4. **`execute()` never throws.** Errors funnel into `result.error` as a typed `AIError` subclass. Same for `stream.result`, `workflow.execute()` / `resume()`, `supervisor.execute()` / `resume()`. See [`@warlock.js/ai/handle-ai-errors/SKILL.md`](@warlock.js/ai/handle-ai-errors/SKILL.md).
5. **Each `execute()` call is isolated.** Fresh internal execution instance per call.
6. **Every error is an `AIError`.** Plain `Error` never leaks. Branch on `error.code` (stable string), `error.category` (coarse), or `instanceof`.
7. **Result shape is uniform.** `{ data, error, usage, report }` across every primitive. `report` is a recursive `BaseReport` tree.
8. **Persistence is delegated** to `@warlock.js/cache`. See [`@warlock.js/ai/persist-ai-data/SKILL.md`](@warlock.js/ai/persist-ai-data/SKILL.md).
9. **Logging is delegated** to `@warlock.js/logger`. See [`@warlock.js/ai/log-ai-calls/SKILL.md`](@warlock.js/ai/log-ai-calls/SKILL.md).
10. **`name` on agents is optional.** Anonymous agents get a deterministic `anon_<provider>_<model>` fingerprint.
11. **Every report carries lineage** — `rootRunId` + `parentRunId` + `reportSchemaVersion: 1`.
12. **`version` is dev-curated, `sessionId` is caller-supplied** — both propagate through nested reports.
13. **Cost is computed at emit time as a per-channel breakdown.** Set `pricing` on the model adapter; `Usage.cost` carries `{ input, output, cachedInput?, cachedOutput? }` per trip, rolled up bottom-up.
14. **Every `AIError` carries a coarse `category`** for retry-policy dispatch (`rate-limit`, `auth`, `content-filter`, `schema`, etc.).

## 30-second example

```ts
import { ai } from "@warlock.js/ai";
import { OpenAISDK } from "@warlock.js/ai-openai";

const openai = new OpenAISDK({ apiKey: process.env.OPENAI_API_KEY! });
const myAgent = ai.agent({ model: openai.model({ name: "gpt-4o-mini" }) });

const { data, text, report, usage, error } = await myAgent.execute("Hello");

if (error) /* typed AIError */ ;
console.log(text, usage.total, report.duration);
```

## Pick a skill

| If the task is about… | Load |
| --- | --- |
| `ai.agent({...})` — single-LLM-turn primitive, structured output, streaming, attachments, `spawnSubAgent` | [`@warlock.js/ai/run-ai-agent/SKILL.md`](@warlock.js/ai/run-ai-agent/SKILL.md) |
| `ai.tool({...})` — typed validated functions the model can call | [`@warlock.js/ai/define-ai-tool/SKILL.md`](@warlock.js/ai/define-ai-tool/SKILL.md) |
| `ai.systemPrompt()` / `ai.persona()` / `ai.instruction()` — composable prompts with placeholders | [`@warlock.js/ai/write-system-prompt/SKILL.md`](@warlock.js/ai/write-system-prompt/SKILL.md) |
| `ai.workflow({...})` — durable resumable pipelines with steps, routing, retry | [`@warlock.js/ai/run-ai-workflow/SKILL.md`](@warlock.js/ai/run-ai-workflow/SKILL.md) |
| `ai.supervisor({...})` — multi-intent routing, fan-out, evaluate loops | [`@warlock.js/ai/run-supervisor/SKILL.md`](@warlock.js/ai/run-supervisor/SKILL.md) |
| `ai.orchestrator({...})` — durable stateful sessions, drift, compaction, resume | [`@warlock.js/ai/run-orchestrator/SKILL.md`](@warlock.js/ai/run-orchestrator/SKILL.md) |
| `ai.planner({...})` — LLM-generated plans over registered capabilities | [`@warlock.js/ai/run-planner/SKILL.md`](@warlock.js/ai/run-planner/SKILL.md) |
| `ai.memory({...})` — working + semantic recall for agents / sessions | [`@warlock.js/ai/use-ai-memory/SKILL.md`](@warlock.js/ai/use-ai-memory/SKILL.md) |
| `ai.checkpoint.*` / `ai.snapshot.*` — orchestrator session + run stores | [`@warlock.js/ai/manage-ai-stores/SKILL.md`](@warlock.js/ai/manage-ai-stores/SKILL.md) |
| DX helpers — `batch` / `fallbackModel` / `eval` + matchers / SLO contracts / `fromFile` | [`@warlock.js/ai/ai-dx-helpers/SKILL.md`](@warlock.js/ai/ai-dx-helpers/SKILL.md) |
| `sdk.embedder({...})` — text-to-vector for RAG tools, vector ingest | [`@warlock.js/ai/embed-text/SKILL.md`](@warlock.js/ai/embed-text/SKILL.md) |
| Agent + supervisor middleware — `budget` / `guardrail` / `semanticCache` + custom hooks | [`@warlock.js/ai/attach-ai-middleware/SKILL.md`](@warlock.js/ai/attach-ai-middleware/SKILL.md) |
| Snapshot resume + semantic cache via `@warlock.js/cache` | [`@warlock.js/ai/persist-ai-data/SKILL.md`](@warlock.js/ai/persist-ai-data/SKILL.md) |
| Configuring framework logging | [`@warlock.js/ai/log-ai-calls/SKILL.md`](@warlock.js/ai/log-ai-calls/SKILL.md) |
| `AIError` hierarchy, `error.code` / `error.category`, retry patterns (incl. `ORCHESTRATOR_*` / `PLANNER_*` families) | [`@warlock.js/ai/handle-ai-errors/SKILL.md`](@warlock.js/ai/handle-ai-errors/SKILL.md) |
| Provider adapters + cost truth (pricing / cache + reasoning tokens / capabilities) | [`@warlock.js/ai/pick-ai-provider/SKILL.md`](@warlock.js/ai/pick-ai-provider/SKILL.md) |
| Observability — `panoptic()` subscriber, queryable trace store, OTEL / Langfuse / console / file exporters | [`@warlock.js/ai-panoptic/observe-with-panoptic/SKILL.md`](@warlock.js/ai-panoptic/observe-with-panoptic/SKILL.md) |

## Package layout

```
@warlock.js/ai               — agent, tool, workflow, supervisor, system-prompt, errors, middleware
@warlock.js/ai-openai        — OpenAI SDK adapter (model + embedder); also OpenRouter / Azure via baseURL
@warlock.js/ai-anthropic     — Anthropic / Claude adapter (Messages API)
@warlock.js/ai-bedrock       — AWS Bedrock adapter (Converse API + Titan embeddings)
@warlock.js/ai-google        — Google / Gemini adapter (@google/genai + batch embeddings)
@warlock.js/ai-ollama        — Ollama adapter for local models
@warlock.js/ai-panoptic      — observability sidecar: panoptic() subscriber → collector → queryable trace store + console / file / OTEL / Langfuse exporters
```

The observability sidecar is OPTIONAL and lives in its own package — it subscribes to the report tree every primitive already emits, so you wire `panoptic(...)` once and never touch primitive code. Load [`@warlock.js/ai-panoptic/observe-with-panoptic/SKILL.md`](@warlock.js/ai-panoptic/observe-with-panoptic/SKILL.md) for collecting / querying traces and [`@warlock.js/ai-panoptic/export-traces/SKILL.md`](@warlock.js/ai-panoptic/export-traces/SKILL.md) for OTEL / Langfuse / console / file exporters.

Runtime deps: `@warlock.js/cache` (persistence), `@warlock.js/logger` (logging), `@warlock.js/seal` (recommended schema lib).

## When NOT to use this skill

- Code importing `openai` / `@anthropic-ai/sdk` directly without going through `@warlock.js/ai` — those are raw provider SDKs.
- Generic JS/TS questions unrelated to agent / tool / workflow / supervisor wiring.

## Design references

- `domains/ai/design/decisions.md` — locked architectural decisions with rationale
- `domains/ai/design/workflow.md` — workflow spec
- `domains/ai/design/supervisor.md` — supervisor spec
- `domains/ai/design/execution-result.md` — unified `ExecuteResult` + recursive `BaseReport` tree
- `domains/ai/conventions/errors.md` — framework-vs-consumer-app error split
