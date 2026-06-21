# `@warlock.js/ai` — skills index

Per-task skills. All cross-references use the form `@warlock.js/<pkg>/<skill>/SKILL.md`.

## Skills

### [`ai-basics/`](./ai-basics/SKILL.md)

Start with @warlock.js/ai — provider-agnostic core for agents / tools / workflows / supervisors / orchestrators. 4-primitive ladder (agent → workflow → supervisor → orchestrator, all shipped) plus planner, memory, stores, and DX helpers. Every primitive returns {data, error, usage, report}. Persistence + logging delegated. Load when importing @warlock.js/ai, picking a primitive, or choosing which AI skill to load.

### [`ai-dx-helpers/`](./ai-dx-helpers/SKILL.md)

Developer-experience helpers — ai.batch (fan-out over a dataset w/ concurrency + retry), ai.fallbackModel (ordered model failover), agent.eval + ai.eval scorers + Vitest matchers (registerAiMatchers / toRouteTo / toConverge / toPassStep / toOutputShape) + ai.mockRouter, SLO/cost budget contracts (ai.middleware.budget({contract}) + readBudgetFallbackSignal), supervisor-level middleware, ai.systemPrompt.fromFile, auto-adapt executables in tools:[]. Load when running an executable over a list, failing over models, evaluating / testing an agent or supervisor, declaring an SLO budget, or seeding a prompt from a file.

### [`attach-ai-middleware/`](./attach-ai-middleware/SKILL.md)

Wire agent + supervisor middleware — ai.middleware.budget (token / USD caps + SLO/cost contract), ai.middleware.guardrail (pre / post content checks), ai.middleware.semanticCache (exact + vector cache via @warlock.js/cache), plus authoring custom hooks (execute / trip / tool). Load when capping cost / tokens, gating input or output, hitting semantic cache before the LLM, attaching supervisor-level middleware, or writing custom hooks.

### [`define-ai-tool/`](./define-ai-tool/SKILL.md)

Define tools with ai.tool({...}) — typed validated async functions the model can call. Covers name / description / action / mode (feedback / silent) / input / execute, ctx.artifacts side-channel, ToolExecutionError. Load when wiring tools into an agent, authoring ai.tool, inspecting result.report.toolCalls, or debugging a ToolExecutionError.

### [`embed-text/`](./embed-text/SKILL.md)

Text-to-vector via sdk.embedder({...}) — embed(string) for single, embedMany(string[]) for batch. Peer primitive on the SDK adapter, not wired into agents. Compose into RAG tools, workflow run steps, or ai.middleware.semanticCache. Load when calling sdk.embedder, building RAG tools, or populating a vector store.

### [`handle-ai-errors/`](./handle-ai-errors/SKILL.md)

Typed AIError hierarchy with stable code strings + coarse category for retry-policy dispatch. execute() never throws — errors surface via result.error. Load when inspecting result.error, branching on error.code / error.category, designing retry / fallback logic, or wrapping framework errors in HTTP errors.

### [`log-ai-calls/`](./log-ai-calls/SKILL.md)

Framework logging delegated to @warlock.js/logger — every primitive emits via the log singleton, configure channels / levels / redaction once at boot. Four-arg call convention (module, action, message, context). Load when configuring AI logging, masking prompts / API keys / PII, picking which events surface, or filtering by module / action.

### [`manage-ai-stores/`](./manage-ai-stores/SKILL.md)

Durable orchestrator stores — ai.checkpoint.{memory,pg,redis}() for cross-turn SESSION STATE and ai.snapshot.{memory,pg,redis}() for in-flight SUPERVISOR/WORKFLOW run state. Two distinct contracts (CheckpointStore vs SnapshotStore), dev-owned pg/redis clients (no peer dep), never-auto-migrated schema(), global defaults via ai.config({defaultCheckpointStore, defaultSnapshotStore}). Load when persisting orchestrator sessions, wiring a pg/redis store, running the store DDL, or untangling checkpoint vs snapshot.

### [`persist-ai-data/`](./persist-ai-data/SKILL.md)

Persistence delegated to @warlock.js/cache — workflow + supervisor snapshot resume via snapshotStore (4.3.0: now a SnapshotStore from ai.snapshot.*, ⚠ moved off raw CacheDriver), semantic cache + memory via vector-capable CacheDriver, global defaults via ai.config({defaultStore}) + ai.config({defaultSnapshotStore}). Covers drift detection + three recovery paths. Load when configuring snapshotStore, calling resume(runId), or handling WorkflowDriftError / SupervisorDriftError.

### [`pick-ai-provider/`](./pick-ai-provider/SKILL.md)

Choose an AI provider adapter — @warlock.js/ai-openai (shipped, also handles OpenRouter / Azure via baseURL), @warlock.js/ai-anthropic, @warlock.js/ai-bedrock, @warlock.js/ai-google, @warlock.js/ai-ollama. Load when picking a provider, deciding between OpenAI direct vs OpenRouter, or understanding which adapter supports a feature (vision / structured / embeddings).

### [`run-ai-agent/`](./run-ai-agent/SKILL.md)

Build agents with ai.agent({...}) — the single-LLM-turn primitive. Covers execute / stream, attachments, structured output, placeholders, events, AgentResult envelope, streamingToolGuard, and ai.spawnSubAgent({...}) (a thin one-shot-agent wrapper with a per-task budget — a general primitive, not planner-specific). Load when calling ai.agent(...), reading AgentResult, wiring options.output / attachments / repair, streaming, or spawning a one-shot sub-agent.

### [`run-ai-workflow/`](./run-ai-workflow/SKILL.md)

Build durable resumable pipelines with ai.workflow({...}) + ai.step({...}) — lifecycle (skip / before / run|agent|parallel / output / after / nextStep), routing on success / failure, retry with backoff, parallel groups, cancel via AbortSignal, snapshot resume. Load when authoring ai.workflow, defining steps, handling WorkflowDriftError, or resuming a run.

### [`run-orchestrator/`](./run-orchestrator/SKILL.md)

Durable stateful sessions with ai.orchestrator({...}) — the capstone of the 4-primitive ladder. Wraps a supervisor with cross-turn session state (checkpointStore), per-turn history windowing, drift detection, post-turn compaction, mid-turn resume (iterate: true + snapshotStore), per-turn memory, typed commands, asTool, and a 3-tier event model. Load when a conversation must persist across calls, resume an interrupted turn, compact session history, or wire per-session memory; report.type "orchestrator", status may be "awaiting-input".

### [`run-planner/`](./run-planner/SKILL.md)

Goal-driven planning with ai.planner({...}) — an LLM GENERATES an ordered plan over your registered capabilities (agents / workflows / supervisors / tools), then the planner EXECUTES it step-by-step, threading each step output into the next. A plan step may delegate via ai.spawnSubAgent({...}) — a general one-shot-agent helper covered in run-ai-agent (not planner-specific). Load when the steps are NOT known up front and the model should plan them; report.type "planner".

### [`run-supervisor/`](./run-supervisor/SKILL.md)

Multi-intent routing with ai.supervisor({...}) — classifier (iter-0 dispatch), router agent OR route callback (iter 1+), intents as agents / workflows / callbacks, fan-out, evaluate quality loop, ack receptionist, ctx.intents.X.execute composition. Load when routing one user input across a fixed roster of specialists.

### [`use-ai-memory/`](./use-ai-memory/SKILL.md)

Agent memory with ai.memory({...}) — a provider-neutral store with two v1 tiers: WORKING (in-run scratch, volatile, recalled by recency) and SEMANTIC (durable cosine-similarity recall over a @warlock.js/cache vector driver via .similar()). remember() / recall() / clear(); wire it into ai.orchestrator({ memory }). Episodic/procedural + decay deferred to 4.4. Load when giving an agent memory, remembering user preferences, doing semantic recall, or wiring per-session working memory.

### [`write-system-prompt/`](./write-system-prompt/SKILL.md)

Compose system prompts via ai.systemPrompt() / ai.persona() / ai.instruction() — immutable builders with {{placeholder}} substitution, plus ai.systemPrompt.fromFile(path) to seed from a file read once at construction. Load when building or chaining system prompts, mixing persona + instruction blocks, using {{placeholder}}, seeding a prompt from a file, or doing per-call override via agent.execute(input, {systemPrompt}).
