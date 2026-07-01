# `@warlock.js/ai` — skills index

Per-task skills. All cross-references use the form `@warlock.js/<pkg>/<skill>/SKILL.md`.

## Skills

### [`ai-basics/`](./ai-basics/SKILL.md)

Start with @warlock.js/ai — provider-agnostic core for agents / tools / workflows / supervisors / orchestrators. 4-primitive ladder (agent → workflow → supervisor → orchestrator, all shipped) plus planner, memory, stores, and DX helpers. Every primitive returns {data, error, usage, report}. Persistence + logging delegated. Load when importing @warlock.js/ai, picking a primitive, or choosing which AI skill to load.

### [`ai-dx-helpers/`](./ai-dx-helpers/SKILL.md)

Developer-experience helpers — ai.batch (fan-out over a dataset w/ concurrency + retry), ai.fallbackModel (ordered model failover), agent.eval + ai.eval scorers + Vitest matchers (registerAiMatchers / toRouteTo / toConverge / toPassStep / toOutputShape) + ai.mockRouter, SLO/cost budget contracts (ai.middleware.budget({contract}) + readBudgetFallbackSignal), supervisor-level middleware, ai.systemPrompt.fromFile, auto-adapt executables in tools:[]. Load when running an executable over a list, failing over models, evaluating / testing an agent or supervisor, declaring an SLO budget, or seeding a prompt from a file.

### [`approve-tool-calls/`](./approve-tool-calls/SKILL.md)

Gate an agent's tool calls behind a human with `ai.human.approval(options)` — the `tool.before` approval-gate middleware. Covers the interrupt policy (`allowlist` / `denylist` / `predicate`, with args-aware predicates and reviewer tags), the approve / reject-with-reason / edit-args decision union, the `ApprovalRequest` a reviewer rules on, the interactive (in-process `await`) handler, the pure `evaluatePolicy` core, and why the gate never throws out of `execute()` (a reject rides `result.error` as an `ApprovalRejectedError`). Load when pausing before a dangerous tool, asking a human before the agent sends / charges / deletes, or letting an operator edit or reject a tool call.

### [`attach-ai-middleware/`](./attach-ai-middleware/SKILL.md)

Wire agent + supervisor middleware — ai.middleware.budget (token / USD caps + SLO/cost contract), ai.middleware.guardrail (pre / post content checks), ai.middleware.semanticCache (exact + vector cache via @warlock.js/cache), plus authoring custom hooks (execute / trip / tool). Load when capping cost / tokens, gating input or output, hitting semantic cache before the LLM, attaching supervisor-level middleware, or writing custom hooks.

### [`define-ai-tool/`](./define-ai-tool/SKILL.md)

Define tools with ai.tool({...}) — typed validated async functions the model can call. Covers name / description / action / mode (feedback / silent) / input / execute, ctx.artifacts side-channel, ToolExecutionError. Load when wiring tools into an agent, authoring ai.tool, inspecting tool dispatches on result.report.children, or debugging a ToolExecutionError.

### [`durable-resume/`](./durable-resume/SKILL.md)

Persist a gated tool call and resume it from another process hours later — the handler saves a `PendingInterrupt` to an `InterruptStore` and throws `InterruptSuspendedError` to suspend the run; `ai.human.resume(interruptId, decision, options)` applies the ruling and (v1) re-runs the turn with the decision pre-seeded. Covers the suspend/surface/resume flow, the idempotent `ResumeResult`, the re-run vs apply-only shapes, and the `ai.human.interrupt.{memory,pg,redis}()` stores (memory ships real; pg/redis lazily import their optional peer). Load when approving from a webhook, persisting the request across processes, or backing interrupts with Postgres / Redis.

### [`embed-text/`](./embed-text/SKILL.md)

Text-to-vector via sdk.embedder({...}) — embed(string) for single, embedMany(string[]) for batch. Peer primitive on the SDK adapter, not wired into agents. Compose into RAG tools, workflow run steps, or ai.middleware.semanticCache. Load when calling sdk.embedder, building RAG tools, or populating a vector store.

### [`eval-datasets-and-ci/`](./eval-datasets-and-ci/SKILL.md)

Datasets + regression-gated eval CI with ai.dataset({...}) feeding agent.eval({cases,baseline,tolerance}). Covers the immutable filterable/shardable dataset (cases / fromFile JSONL), DatasetEntry tags, EvalReport.regression (regressed/added/removed/passed) against a baseline, and the ai.eval reporters toJUnit / toJSON / fromJSON for CI artifacts + committed baselines. Triggers: `ai.dataset`, `DatasetContract`, `DatasetEntry`, `DatasetOptions`, `dataset.filter`, `dataset.shard`, `fromFile`, `agent.eval`, `EvalOptions`, `EvalReport`, `EvalCaseResult`, `EvalRegression`, `baseline`, `tolerance`, `ai.eval.toJUnit`, `ai.eval.toJSON`, `ai.eval.fromJSON`, `diff`, JSONL; 'eval dataset from a JSONL file', 'shard an eval suite across CI jobs', 'fail CI on an eval regression', 'emit a JUnit report', 'snapshot an eval baseline'; typical import `import { ai } from "@warlock.js/ai"`. Skip: the scorers + LLM-as-judge + Vitest matchers themselves — `@warlock.js/ai/ai-dx-helpers/SKILL.md` (registerAiMatchers / ai.eval.exact|contains|predicate|judge); record/replay of model calls for deterministic tests — `@warlock.js/ai/record-replay-llm/SKILL.md`; competing libs `promptfoo`, `braintrust`.

### [`generate-images/`](./generate-images/SKILL.md)

Text-to-image with ai.image({ model: sdk.image({ name }), prompt }) — the image-OUTPUT verb (Theme I), returning the uniform never-throws {data, error, usage, report} envelope with cost-truth + panoptic observation. Models come from an adapter's image() factory: OpenAI gpt-image-* (token-metered) / dall-e-* (per-image), Google imagen-* (per-image). Result images are a discriminated GeneratedImage = {type:"base64"} | {type:"url"}. Triggers: `ai.image`, `sdk.image`, `openai.image`, `google.image`, `ImageModelContract`, `GeneratedImage`, `ImageModelPricing`, `perImage`; 'generate an image', 'text to image', 'gpt-image', 'dall-e', 'imagen', 'product thumbnail', 'image output'; typical import `import { ai } from "@warlock.js/ai"` + `import { OpenAISDK } from "@warlock.js/ai-openai"`. Skip: image INPUT / vision attachments to a chat agent — `@warlock.js/ai/run-ai-agent/SKILL.md`; embeddings — `@warlock.js/ai/embed-text/SKILL.md`; competing libs raw `openai.images.generate`, `langchain` image tools.

### [`handle-ai-errors/`](./handle-ai-errors/SKILL.md)

Typed AIError hierarchy with stable code strings + coarse category for retry-policy dispatch. execute() never throws — errors surface via result.error. Load when inspecting result.error, branching on error.code / error.category, designing retry / fallback logic, or wrapping framework errors in HTTP errors.

### [`log-ai-calls/`](./log-ai-calls/SKILL.md)

Framework logging delegated to @warlock.js/logger — every primitive emits via the log singleton, configure channels / levels / redaction once at boot. Four-arg call convention (module, action, message, context). Load when configuring AI logging, masking prompts / API keys / PII, picking which events surface, or filtering by module / action.

### [`manage-ai-stores/`](./manage-ai-stores/SKILL.md)

Durable orchestrator stores — ai.checkpoint.{memory,pg,redis}() for cross-turn SESSION STATE and ai.snapshot.{memory,pg,redis}() for in-flight SUPERVISOR/WORKFLOW run state. Two distinct contracts (CheckpointStore vs SnapshotStore), dev-owned pg/redis clients (no peer dep), never-auto-migrated schema(), global defaults via ai.config({defaultCheckpointStore, defaultSnapshotStore}). Load when persisting orchestrator sessions, wiring a pg/redis store, running the store DDL, or untangling checkpoint vs snapshot.

### [`manage-prompts/`](./manage-prompts/SKILL.md)

Unified prompt registry — ai.prompts: one process-wide store of named, versioned systemPrompt(...) builders keyed by name@version. Register by giving a prompt meta.name (auto-registers), resolve by get / resolve(name, versionOrTag, placeholders) / the inline name@selector form, bulk-register with define, pin tags with tag, compare with diff, round-trip with export / import, and quality-check with a unified validate (deterministic missing-placeholder check + optional Nova-safe LLM-as-judge with verdict caching). Compose with systemPrompt().merge(name, { fromVersion }) — provenance in meta.composedFrom. ai.prompt is now a thin FACADE over ai.prompts (breaking vs the old standalone registry). Load when registering / resolving / versioning / tagging / diffing / exporting / validating prompts by name, or migrating off the old ai.prompt registry. Skip: the systemPrompt builder itself — `@warlock.js/ai/write-system-prompt/SKILL.md`; eval scoring — `@warlock.js/ai/eval-datasets-and-ci/SKILL.md`.

### [`observe-ai-flows/`](./observe-ai-flows/SKILL.md)

The core Observer seam — a generic, tool-agnostic observability hook every flow routes its completed ExecutionReport through. Covers the per-flow `observe?: boolean | Observer` option on ai.agent / workflow / supervisor / team, the global registry (registerObserver / getObservers / setObserveAll / isObserveAll / clearObservers), resolveObservers / notifyObservers resolution, the opt-in AgentConfig.captureMessages → AgentReport.messages full-history capture, the onConfigApplied dependency-inversion seam, and that @warlock.js/ai-panoptic is the batteries-included Observer. Triggers: `Observer`, `observe`, `registerObserver`, `getObservers`, `setObserveAll`, `isObserveAll`, `clearObservers`, `resolveObservers`, `notifyObservers`, `FlowObserveOption`, `ExecutionReport`, `captureMessages`, `AgentReport.messages`, `CapturedMessage`, `onConfigApplied`, `observeAll`; 'observe an agent run', 'send finished reports to a collector', 'capture the full message history', 'observe every flow by default', 'wire panoptic / tracing'; typical import `import { ai, registerObserver } from "@warlock.js/ai"`. Skip: structured logging of events — `@warlock.js/ai/log-ai-calls/SKILL.md`; reading the report tree shape (trips / children) — `@warlock.js/ai/run-ai-agent/SKILL.md`; per-call cost / usage rollup — `@warlock.js/ai/handle-ai-errors/SKILL.md`. The batteries-included Observer is the `@warlock.js/ai-panoptic` package.

### [`persist-ai-data/`](./persist-ai-data/SKILL.md)

Persistence delegated to @warlock.js/cache — workflow + supervisor snapshot resume via snapshotStore (4.3.0: now a SnapshotStore from ai.snapshot.*, ⚠ moved off raw CacheDriver), semantic cache + memory via vector-capable CacheDriver, global defaults via ai.config({defaultStore}) + ai.config({defaultSnapshotStore}). Covers drift detection + three recovery paths. Load when configuring snapshotStore, calling resume(runId), or handling WorkflowDriftError / SupervisorDriftError.

### [`pick-ai-provider/`](./pick-ai-provider/SKILL.md)

Choose an AI provider adapter — @warlock.js/ai-openai (shipped, also handles OpenRouter / Azure via baseURL), @warlock.js/ai-anthropic, @warlock.js/ai-bedrock, @warlock.js/ai-google, @warlock.js/ai-ollama. Load when picking a provider, deciding between OpenAI direct vs OpenRouter, or understanding which adapter supports a feature (vision / structured / embeddings).

### [`record-replay-llm/`](./record-replay-llm/SKILL.md)

Deterministic, offline LLM tests with ai.vcr(model,{path,mode}) — a record/replay decorator over ANY ModelContract that intercepts only complete()/stream(), delegates name/provider/capabilities/pricing to the inner model, and hashes each request against a JSON cassette on disk. Covers the three modes (record / replay / auto), the cassette format, save(), VcrCassetteMissError, streaming round-trip, hashOptions, and composing below fallbackModel. Triggers: `ai.vcr`, `vcr`, `VcrModel`, `VcrOptions`, `VcrMode`, `Cassette`, `CassetteEntry`, `VcrCassetteMissError`, `hashRequest`, `DEFAULT_HASH_OPTIONS`, `mode`, `path`, `hashOptions`, `save`, `cassette`, record, replay, cassette; 'record LLM responses for tests', 'replay model calls offline in CI', 'deterministic agent test without hitting the provider', 'cassette for model calls'; typical import `import { ai } from "@warlock.js/ai"`. Skip: eval scoring + regression gating — `@warlock.js/ai/eval-datasets-and-ci/SKILL.md`; the Vitest matchers + mockRouter — `@warlock.js/ai/ai-dx-helpers/SKILL.md`; choosing a provider adapter — `@warlock.js/ai/pick-ai-provider/SKILL.md`; competing libs `nock`, `polly.js`.

### [`run-ai-agent/`](./run-ai-agent/SKILL.md)

Build agents with ai.agent({...}) — the single-LLM-turn primitive. Covers execute / stream, attachments, structured output, placeholders, events, AgentResult envelope, streamingToolGuard, the judge-safe preset (ai.agent.judge / judge: true — lenient JSON parse + repair + never-throw for Nova-class LLM-as-judge graders), and ai.spawnSubAgent({...}) (a thin one-shot-agent wrapper with a per-task budget — a general primitive, not planner-specific). Load when calling ai.agent(...), reading AgentResult, wiring options.output / attachments / repair, building a resilient LLM-as-judge, streaming, or spawning a one-shot sub-agent.

### [`run-ai-rag/`](./run-ai-rag/SKILL.md)

Retrieval-augmented generation with ai.rag({...}) — a chunk → embed → vector-store → retrieve → rerank → cite pipeline that reuses ai.embedder + a @warlock.js/cache CacheDriver. Covers index() / retrieve() / clear() / asTool(), chunking strategies (recursive | markdown | sentence | fixed), Citation / RetrievedChunk provenance, and the opt-in rerankers ai.rag.keywordReranker / ai.rag.llmReranker. Triggers: `ai.rag`, `rag.index`, `rag.retrieve`, `rag.clear`, `rag.asTool`, `RagConfig`, `RagDocument`, `RetrieveOptions`, `RetrieveResult`, `RetrievedChunk`, `Citation`, `ChunkOptions`, `ChunkType`, `ai.rag.keywordReranker`, `ai.rag.llmReranker`, `cacheVectorStore`, `VectorStore`, `topK`, `threshold`, `candidates`; 'build a knowledge base', 'retrieve relevant chunks for a query', 'cite the source of an answer', 'chunk markdown for embedding', 'rerank retrieval results', 'expose retrieval as a tool'; typical import `import { ai } from "@warlock.js/ai"`. Skip: raw single-string embedding — `@warlock.js/ai/embed-text/SKILL.md`; exact + vector LLM-response cache — `@warlock.js/ai/attach-ai-middleware/SKILL.md` (ai.middleware.semanticCache); tool wiring — `@warlock.js/ai/define-ai-tool/SKILL.md`; competing libs `langchain`, `llamaindex`.

### [`run-ai-team/`](./run-ai-team/SKILL.md)

Manager-led multi-agent teams with ai.team({...}) — transparent sugar over ai.supervisor that maps a manager → route/router, members → intents, and a gate → evaluate, returning a REAL SupervisorContract (no new loop, no new contract). Covers the built-in gate strings "quality" (review-then-fix) and "verify" (test-then-fix), a custom gate function, role mapping (roles / gateKey), and the verbatim supervisor pass-throughs (goal / output / state / maxIterations / snapshotStore / on / observe). Triggers: `ai.team`, `TeamConfig`, `TeamGate`, `TeamGateFn`, `TeamMemberValue`, `manager`, `members`, `gate`, `roles`, `gateKey`, `buildQualityGate`, `buildVerifyGate`, `SupervisorContract`; 'build a team of agents', 'manager that delegates to members', 'review then fix loop', 'test then fix loop', 'quality gate for a multi-agent run'; typical import `import { ai } from "@warlock.js/ai"`. Skip: routing one input to a fixed roster directly — `@warlock.js/ai/run-supervisor/SKILL.md` (team is sugar over it); durable cross-turn sessions — `@warlock.js/ai/run-orchestrator/SKILL.md`; LLM-generated plans — `@warlock.js/ai/run-planner/SKILL.md`; competing libs `crewai`, `autogen`.

### [`run-ai-workflow/`](./run-ai-workflow/SKILL.md)

Build durable resumable pipelines with ai.workflow({...}) + ai.step({...}) — lifecycle (skip / before / run|agent|parallel / output / after / nextStep), routing on success / failure, retry with backoff, parallel groups, cancel via AbortSignal, snapshot resume. Load when authoring ai.workflow, defining steps, handling WorkflowDriftError, or resuming a run.

### [`run-orchestrator/`](./run-orchestrator/SKILL.md)

Durable stateful sessions with ai.orchestrator({...}) — the capstone of the 4-primitive ladder. Wraps a supervisor with cross-turn session state (checkpointStore), per-turn history windowing, drift detection, post-turn compaction, mid-turn resume (iterate: true + snapshotStore), per-turn memory, typed commands, asTool, and a 3-tier event model. Load when a conversation must persist across calls, resume an interrupted turn, compact session history, or wire per-session memory; report.type "orchestrator", status may be "awaiting-input".

### [`run-planner/`](./run-planner/SKILL.md)

Goal-driven planning with ai.planner({...}) — an LLM GENERATES an ordered plan over your registered capabilities (agents / workflows / supervisors / tools), then the planner EXECUTES it step-by-step, threading each step output into the next. A plan step may delegate via ai.spawnSubAgent({...}) — a general one-shot-agent helper covered in run-ai-agent (not planner-specific). Load when the steps are NOT known up front and the model should plan them; report.type "planner".

### [`run-supervisor/`](./run-supervisor/SKILL.md)

Multi-intent routing with ai.supervisor({...}) — classifier (iter-0 dispatch), router agent OR route callback (iter 1+), intents as agents / workflows / callbacks, fan-out, evaluate quality loop, ack receptionist, ctx.intents.X.execute composition, and sub-agent trace nesting (a callback that calls agent.execute() directly auto-nests agent → tool under the callback span with cost rolled up — same for team members + orchestrator turns). Load when routing one user input across a fixed roster of specialists, or when a callback sub-agent shows as a lone $0 span instead of nesting.

### [`use-ai-memory/`](./use-ai-memory/SKILL.md)

Agent memory with ai.memory({...}) — a provider-neutral store with two v1 tiers: WORKING (in-run scratch, volatile, recalled by recency) and SEMANTIC (durable cosine-similarity recall over a @warlock.js/cache vector driver via .similar()). remember() / recall() / clear(); wire it into ai.orchestrator({ memory }). Episodic/procedural + decay deferred to 4.4. Load when giving an agent memory, remembering user preferences, doing semantic recall, or wiring per-session working memory.

### [`use-runtime-skills/`](./use-runtime-skills/SKILL.md)

Progressive-disclosure agent skills with ai.skills({...}) and the first-class `skills` option on ai.agent — an always-injected cheap metadata catalog plus an on-demand loadSkill tool, backed by directory / url / store sources. Covers inject ("all" | {select:"semantic",topK,embedder}), maxLoadsPerRun, scope tags, the MockSkillsStore, semantic preload, and the inert-by-default Phase-2 self-authoring (saveSkill + default-DENY review gate → promote). Triggers: `ai.skills`, `SkillsConfig`, `SkillsContract`, `SkillSource`, `SkillInjectMode`, `SkillRecord`, `SkillCatalogEntry`, `loadSkill`, `loadSkillTool`, `saveSkill`, `saveSkillTool`, `SkillReviewGate`, `runReviewGate`, `MockSkillsStore`, `proceduralSkillStore`, `maxLoadsPerRun`, `inject`, `scope`, `review`, the agent `skills:` option; 'give an agent loadable skills', 'progressive disclosure of instructions', 'catalog of skills the model pulls on demand', 'semantic preload of skill bodies', 'let an agent author and review a skill'; typical import `import { ai } from "@warlock.js/ai"`. Skip: composing static system prompts — `@warlock.js/ai/write-system-prompt/SKILL.md`; durable agent memory tiers — `@warlock.js/ai/use-ai-memory/SKILL.md`; defining callable tools — `@warlock.js/ai/define-ai-tool/SKILL.md`.

### [`write-system-prompt/`](./write-system-prompt/SKILL.md)

Compose system prompts via ai.systemPrompt() / ai.persona() / ai.instruction() — immutable builders with {{placeholder}} substitution, plus ai.systemPrompt.fromFile(path) to seed from a file read once at construction. Carry identity with .meta({ name, version, description, required }) (a name auto-registers in ai.prompts) and compose with merge(...blocks) / merge(contract) / merge(name, { fromVersion }) (provenance in meta.composedFrom). Load when building or chaining system prompts, mixing persona + instruction blocks, naming / versioning a prompt, merging prompts, using {{placeholder}}, seeding a prompt from a file, or doing per-call override via agent.execute(input, {systemPrompt}).
