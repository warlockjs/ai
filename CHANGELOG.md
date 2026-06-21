# Changelog — @warlock.js/ai

All notable changes to `@warlock.js/ai` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). `@warlock.js/*` packages are released in lockstep — every package shares the same version number, so a version below may list only the changes that affected this package.

## 4.4.0 - 2026-06-21

### Fixed

- **Planner: OpenAI strict structured-output 400.** The generated plan schema now lists every property in `required` (the optional `id` / `reason` / `dependsOn` are nullable) and no longer emits `minItems` / `maxItems`, so `ai.planner()` no longer fails with `400 Invalid schema for response_format … 'required' … Missing 'id'` against OpenAI strict `json_schema` mode. `maxSteps` and the non-empty-plan check are enforced at runtime / in `validate()`.
- **Report / result types no longer collapse to `never` under strict TypeScript.** The narrowing report types (`PlannerReport`, `OrchestratorReport`, `SupervisorReport`, `WorkflowReport`, `ToolCall`) and the two result types that re-declare `report` (`PlannerResult`, `OrchestratorResult`) now override the discriminant via `Omit<BaseReport, "type">` / `Omit<ExecuteResult, "report">` instead of intersecting `BaseReport & { type: "…" }`, so `result.report` no longer types as `never` (*"Property 'plan' does not exist on type 'never'"*). Type-only — no runtime change.

## 4.3.0 - 2026-06-21

### ⚠ BREAKING

- **Supervisor + workflow snapshot persistence moved from `CacheDriver` to the dedicated `SnapshotStore` contract.** `SupervisorConfig.snapshotStore` and `WorkflowConfig.snapshotStore` are now typed `SnapshotStore` (from `src/contracts/orchestrator/`), no longer `CacheDriver<…>`. The per-primitive fallback is now `ai.config({ defaultSnapshotStore })` (a `SnapshotStore`) instead of `ai.config({ defaultStore })` (a `CacheDriver`); `defaultStore` continues to serve the semantic-cache middleware only. **Migration:** replace `snapshotStore: cache.driver("redis", { client })` with `snapshotStore: ai.snapshot.redis({ client })` (and `ai.snapshot.{memory,pg}` for the other tiers), and move any `ai.config({ defaultStore })` you relied on for snapshot resume to `ai.config({ defaultSnapshotStore: ai.snapshot.<tier>(…) })`. Semantic-cache `defaultStore` wiring is unaffected.

### Added

#### Orchestrator (stateful primitive, "v2")

- `ai.orchestrator()` — stateful session manager wrapped around a supervisor: owns durable session/history/context, drift detection, history compaction, resume, and a command surface
- `orchestrator.asTool()` — expose an orchestrator inside an agent's tool loop
- 3-tier orchestrator event surface via `OrchestratorEmitter`, including `orchestrator.compaction.failed` (emitted when a post-turn `summarize` / `onCompact` step throws, instead of silently swallowing it)
- `OrchestratorContract`, `OrchestratorConfig`, `OrchestratorResult`, and the orchestrator event / command contract types (`src/contracts/orchestrator/`)
- `OrchestratorFailedError`, `OrchestratorConfigError`, `OrchestratorDriftError`, `OrchestratorCancelledError` error classes
- `"orchestrator"` member added to the `ReportType` union

#### Checkpoint + snapshot stores

- `CheckpointStore` + `CheckpointRecord` contracts for orchestrator session state, including an optional `prune?()` hook so `keepSnapshots` bounds growth (implemented on the in-memory store)
- `SnapshotStore` contract plus structural `PgClientLike` / `RedisClientLike` client interfaces
- `ai.checkpoint.{memory,pg,redis}()` — durable orchestrator session checkpoint stores
- `ai.snapshot.{memory,pg,redis}()` — supervisor / workflow run snapshot stores
- `PgCheckpointOptions`, `RedisCheckpointOptions`, `PgSnapshotStoreOptions`, `RedisSnapshotStoreOptions` types
- `defaultCheckpointStore` and `defaultSnapshotStore` fields on `ai.config()`, with `resolveDefaultCheckpointStore()` / `resolveDefaultSnapshotStore()` resolvers

#### Memory

- `ai.memory()` — agent-memory store with four tiers: **working** (in-run scratch, recency), **semantic** (durable facts by cache-driver `.similar()`), **episodic** (durable events, similarity blended with recency via per-entry timestamp + `recencyWeight` / `halfLifeMs`), and **procedural** (durable how-tos, similarity blended with reinforcement — re-remembering increments a use count, `reinforcementWeight`). Decay / forgetting remains deferred
- The `MemoryTier` union widened from `"working" | "semantic"` to add `"episodic" | "procedural"` (non-breaking). The three vector tiers default to distinct namespaces (`ai.memory.semantic` / `.episodic` / `.procedural`) so they don't collide on a shared cache driver
- Orchestrator `memory?` field wiring memory recall + write-back into each turn
- `MemoryContract`, `MemoryConfig`, `SemanticMemoryConfig`, `EpisodicMemoryConfig`, `ProceduralMemoryConfig`, `MemoryItem`, `MemoryTier`, `RecalledMemory`, `RecallOptions` types

#### Planner

- `ai.planner()` — LLM generates an ordered plan over your registered capabilities, then executes it step-by-step
- `ai.spawnSubAgent()` — one-shot delegation to a fresh single-use agent with an optional per-task budget. A **general** agent helper (lives on the agent surface, not the planner): usable from a planner step, a tool, a workflow step, or hand-rolled orchestration — the planner engine does not require it
- `PlannerConfig`, `PlannerCapability`, `PlannerResult`, `PlannerReport`, `PlannerStep`, `PlannerPlan` types
- `"planner"` member added to the `ReportType` union
- `PlannerFailedError`, `PlannerPlanInvalidError`, `PlannerCancelledError` error classes

#### Cost-truth contract surface (all five adapters)

- `Usage.reasoningTokens` — the reasoning / thinking subset of output tokens, priced separately
- `ModelPricing.{cachedInput, cachedOutput, reasoning}` per-channel rates; `Usage.cost` rolls up `{ input, output, cachedInput?, cachedOutput? }`
- `ModelCallOptions.{reasoning, cacheControl}` — reasoning-effort / thinking-budget and prompt-cache breakpoint controls
- `ModelContract.capabilities.{reasoning, cacheControl}` flags — adapters that lack the feature ignore the options rather than forwarding unsupported parameters

#### DX helpers

- `ai.router()` — builds a supervisor router agent with a generated `{ next, reasoning }` schema and intent-listing prompt
- `ai.fanOut()` — spreads one agent/workflow into N keyed intents for voting / self-consistency
- `ai.batch()` — run an executable over a dataset with bounded concurrency + per-item retry; `BatchResult`, `BatchItemResult`, `BatchOptions` types
- `ai.fallbackModel()` — wraps an ordered model list, failing over on transient provider errors
- `ai.mockRouter()` — canned routing-decision replay for supervisor tests
- `agent.eval()` — runs scored evaluation cases and returns an aggregate `EvalReport`; `EvalCase`, `EvalScore`, `EvalScorer`, `EvalJudge`, `EvalOptions`, `EvalCaseResult`, `EvalReport` types
- `ai.eval.{exact,contains,predicate,judge}()` built-in eval scorers (incl. LLM-as-judge)
- `registerAiMatchers()` — Vitest matchers `toRouteTo` / `toConverge` / `toPassStep` / `toOutputShape` (plus library-agnostic `matchRouteTo` / `matchConverge` / `matchPassStep` / `matchOutputShape` verdict functions and the `AiMatchers` type)
- Supervisor-level middleware via the `supervisor` hook map on `AgentMiddleware` and `SupervisorConfig.middleware`
- `ai.systemPrompt.fromFile(path)` (and `SystemPrompt.fromFile(path)`) — seed a system prompt from a file read once at construction
- Executables passed in an agent's `tools: [...]` are auto-adapted into tools (workflows / supervisors / orchestrators expose `.asTool()` and compose directly)

## 4.2.0

### Fixed

- No-argument tools (declared without an `input` schema) no longer crash on invocation. A schemaless tool threw `Cannot read properties of undefined (reading '~standard')`; `tool.invoke` now skips validation when no schema is present and passes the raw input straight to the handler.

## 4.1.15

- Baseline — per-package changelog tracking starts at this version.
