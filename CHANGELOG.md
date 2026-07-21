# Changelog — @warlock.js/ai

All notable changes to `@warlock.js/ai` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). `@warlock.js/*` packages are released in lockstep — every package shares the same version number, so a version below may list only the changes that affected this package.

## 4.8.1 - 2026-07-21

### Fixed

- `setAIConfig`'s `onConfigApplied` listener notification no longer swallows a misbehaving listener's exception silently — it's now logged via `log.error("ai", "configListener", error)`

## 4.8.0 - 2026-07-19

### Added

- **`reasoning: { effort: "none" }`** — a neutral "run without reasoning, explicitly" level on `ReasoningEffort`; OpenAI emits `reasoning_effort: "none"` so gpt-5 / o-series accept function tools, and budget-based adapters (Anthropic / Bedrock / Google / Ollama) disable thinking.

## 4.7.0

### Added

- **`systemPrompt().refined({ model, criteria, store })`** — the prompt compiler. Humans keep writing human prompt text; the refined wrapper lazily rewrites it into a model-optimized version on first agent use and pins the result like a lockfile (re-compiled only when the source text, refiner model, `criteria`, or recipe version change — never silently). `await refined.refine()` returns the compiled template **string** (placeholders intact — routes / previews / warmup / CI; throws `PromptRefinementError` on failure) and `await refined.refinePrompt()` returns a composable prompt with `meta.refinedFrom` / `meta.refinerModel` provenance (register it to `diff` original vs refined). Placeholder parity is machine-enforced (one repair re-ask, then rejected); the lazy agent path never throws — it warns once and serves the original.
- **`ai.prompts.validate({ criteria })`** — validate a prompt against your **own** rules. Pass `criteria` (a string or a list of short rules) and, when a `judge` model is supplied, it replaces the built-in quality rubric so the judge's `score` / `issues` reflect your criteria (a failed rule is named in `issues`). Advisory only — never flips the deterministic `ok`; folded into the `judgeCache` key so different rules re-run.

## 4.6.0

### Added

- **`ai.image(params)`** — image generation, the first verb of the output-modality track (Theme I). Wraps an `ImageModelContract` in the uniform never-throws `{ data, error, usage, report }` envelope, with cost-truth (per-token for `gpt-image`, per-image for DALL·E / Imagen) folded into the same `Usage.cost` rollup and a `type: "image"` report routed to observers. Ships on the OpenAI + Google adapters.
- **`SDKAdapterContract.image?(config)`** — the image-model capability seam, mirroring `embedder?()`. Adds `ImageModelContract`, `GeneratedImage` (discriminated `base64` | `url`), `ImageModelPricing`, and `ImageGenerationOptions`.
- **`MockSDK().image(...)` + `MockImageModel`** — deterministic image doubles (scriptable responses, recorded calls, pricing) for tests.
- **`ai.speech(params)` + `ai.transcribe(params)`** — text-to-speech and speech-to-text, the audio verbs of the modality track. Same uniform never-throws envelope + cost-truth (per-character / per-minute / per-token). New `SpeechModelContract` / `TranscriptionModelContract` on `SDKAdapterContract.speech?()` / `transcribe?()`, plus `MockSpeechModel` / `MockTranscriptionModel`.
- **`ai.audioFromFile(path)` / `ai.audioFromBuffer(bytes, mediaType)` / `ai.audioMediaTypeForFilename(name)`** — non-AI utilities that package audio (WhatsApp `.ogg`/`.opus`, iOS `.m4a`, …) into the `AudioInput` shape `ai.transcribe` consumes.
- **`ai.rag.pgVectorStore({ client })`** — a Postgres + pgvector vector store satisfying `VectorStoreContract` (upsert / query / removeNamespace), with an `ensureSchema()` DDL helper and a lazy `pg` optional peer.
- **`ai.rag.loadText` / `loadHtml` / `loadWeb` / `loadPdf`** — document loaders producing `RagDocument`s for `.index()`. `loadWeb` is SSRF-safe (routes through `guardedFetch` / `OutboundPolicy`); `loadPdf` uses a lazy `pdf-parse` optional peer.
- **Durable mid-run crash-resume** — opt-in `durable: { store, deleteOnComplete? }` on `ai.agent` / `ai.planner` with a stable `runId` + `agent.resume(runId)` / `planner.resume(runId)`. Per-trip (agent) / per-node (planner) checkpoints reuse `ai.snapshot.{memory,pg,redis}`; drift detection via `AgentDriftError` / `PlannerDriftError` (bypass with `{ force: true }`); completed work never re-runs its tools and usage is never double-counted.
- **`ai.rag.*` namespace** now also carries `chunk`, `cacheVectorStore`, `pgVectorStore`, `loadText`/`loadHtml`/`loadWeb`/`loadPdf`, `bm25Rank`, `reciprocalRankFusion`, `hybridRank`, `multiQuery` (previously standalone-only exports), for `ai.*`-namespace consistency.

## 4.5.0 - 2026-07-01

### Added

- **`ai.rag(config)`** — retrieval-augmented generation in core: a chunk → embed → retrieve → cite pipeline that reuses your existing embedder and cache, with zero new dependencies. Includes hybrid retrieval (dense + BM25 reciprocal-rank fusion), keyword / LLM rerankers, and multi-query expansion.
- **`ai.team(config)`** — manager-led multi-agent teams: thin sugar over `ai.supervisor` for the review-then-fix and test-then-fix shapes.
- **`ai.skills(config)`** — runtime agent skills with progressive disclosure: a cheap always-injected catalog plus an on-demand `loadSkill` tool. Adds a `skills` option on `ai.agent`.
- **`ai.streamObject(...)`** — structured-output streaming: partial-object snapshots as tokens arrive, with a strict final parse against the response schema.
- **`ai.serve(executable, options)`** — serve any agent / workflow / supervisor as an SSE HTTP endpoint.
- **Multimodal attachments** — `ContentPart` gains `pdf` and `audio` variants alongside text / image, resolved to provider-ready parts (PDF wired on the Anthropic and Bedrock adapters).
- **Planner DAG execution, re-planning, and plan-only approval** — run independent steps concurrently, revise the plan when a step fails, or return a plan for approval before it executes.
- **Generic `Observer` seam** — route any flow's run report to pluggable observers (e.g. `@warlock.js/ai-panoptic`) without coupling core to a backend.
- **`ai.prompts` + `ai.prompt`** — a process-wide registry of named, versioned `systemPrompt(...)` builders (resolved by `name@version` / `name@tag`) with `define` / `tag` / `diff` / `export` / `import` and a unified `validate` (deterministic missing-placeholder check plus an optional Nova-safe LLM-judge); `ai.prompt` is a thin facade over it.
- **`SystemPromptContract` identity + provenance** — `.meta({ name, version, description, required })` (a name auto-registers in `ai.prompts`), `.merge(...blocks)` / `.merge(contract)` / `.merge(name, { fromVersion })`, and deterministic `meta.composedFrom` labels.
- **`ai.dataset(options)`** — filterable, shardable evaluation case sets that feed `agent.eval`, with baseline / regression detection and CI reporters.
- **`ai.vcr(model, options)`** — record / replay any model against an on-disk cassette for deterministic, offline tests, with `recordRequest` modes and `redactRequest` / `redactResponse` / `redactError` hooks.
- **`ai.agent.judge(config)`** — judge-safe agent preset (also `ai.agent({ judge: true })`): lenient JSON parsing, bounded repair re-asks, and never-throw verdicts on Nova-class models.
- **Human-in-the-loop approval now ships in core** (`ai.human.*`, formerly `@warlock.js/ai-human`) — a tool-approval gate plus durable interrupt / resume.
- **Content guardrails now ship in core** (`ai.guardrail.*`, formerly `@warlock.js/ai-guard`) — PII / topic / injection / moderation detectors.
- **Orchestrator `sessionLock`** — per-session turn serialization (default in-process mutex keyed by `sessionId`, pluggable distributed lock) so concurrent same-session turns can't lose a checkpoint update.
- **Sub-agent trace nesting** — a supervisor / team / orchestrator callback that calls `agent.execute()` directly now nests `callback → agent → tool` with rolled-up usage / cost.
- **`AgentReport.systemPrompt`** — the resolved system prompt sent to the model is now recorded on the agent report.

### Changed

- **`ai.team` runs report `type: "team"`** — a first-class `ReportType` (was `"supervisor"`) so observers distinguish team runs on the wire.
- **Deterministic parallel workflow state merge** — parallel children merge into the parent in declaration order (last-declared wins on a conflicting key) instead of completion order; an optional per-step `mergeState` reducer overrides it.
- **Safer batch / RAG defaults** — `ai.batch` warns once on a large unbounded run (pass an explicit `concurrency` or `"unbounded"`); `ai.rag` accepts `limits` (`maxDocuments` / `maxChunks` / `maxBytes`) that fail before any embedding spend.

### Fixed

- **Cancellation propagates through composite tools** — a cancelled outer agent now aborts a nested agent / workflow / supervisor invoked via `.asTool()` (the run signal threads into the nested `execute`).
- **Observer / event-handler errors are surfaced, not swallowed** — a throwing observer or `on` handler stays isolated (never crashes the run) but is now warned once / routed to a hook instead of disappearing silently.
- **`budget({ maxCostUSD })` fail-open closed** — a cost cap with no matching model pricing now warns once (naming the model) instead of silently never tripping.

### Security

- **Shared `OutboundPolicy` + `redact()`** — one SSRF-safe outbound-fetch guard (scheme + host allowlist, post-DNS private-IP deny, max-bytes, timeout, injectable fetch) and one redaction utility, consumed across attachments, URL skills, VCR, and the error path.
- **Attachment trust boundary** (`AttachmentPolicy`) — remote-text attachment fetch is default-deny (opt in with a policy), local reads honor an `allowedRoots` sandbox, and bare-string local paths warn (staged deprecation).
- **URL skill sources hardened** — the manifest fetch runs through `OutboundPolicy` and every record is runtime-validated before it enters model context; adds cache-TTL controls.
- **Guardrail coverage documented** — input detectors inspect text only; non-text attachment content needs an attachment-level policy.

## 4.4.0 - 2026-06-21

### Fixed

- **Planner: OpenAI strict structured-output `400`.** The generated plan schema now lists every property in `required` and drops `minItems` / `maxItems`, so `ai.planner()` no longer fails against OpenAI strict `json_schema` mode.
- **Report / result types no longer collapse to `never` under strict TypeScript.** The narrowing report / result types now override the discriminant via `Omit<…>` instead of intersection. Type-only — no runtime change.

## 4.3.0 - 2026-06-21

### ⚠ BREAKING

- **Supervisor + workflow snapshot persistence moved from `CacheDriver` to the dedicated `SnapshotStore` contract.** The per-primitive fallback is now `ai.config({ defaultSnapshotStore })`. **Migration:** replace `snapshotStore: cache.driver("redis", { client })` with `snapshotStore: ai.snapshot.redis({ client })` (and `ai.snapshot.{memory,pg}` for the other tiers).

### Added

- `ai.orchestrator()` — stateful session manager over a supervisor: durable session / history / context, drift detection, history compaction, resume, and a command surface (`orchestrator.asTool()`, a 3-tier event surface, and `OrchestratorContract` / config / error types).
- `ai.checkpoint.{memory,pg,redis}()` and `ai.snapshot.{memory,pg,redis}()` — durable orchestrator-session and supervisor / workflow run stores, with matching `defaultCheckpointStore` / `defaultSnapshotStore` config fields.
- `ai.memory()` — agent-memory store with four tiers: **working** (in-run scratch), **semantic** (durable facts), **episodic** (durable, recency-blended events), and **procedural** (durable, reinforcement-blended how-tos). Wired into the orchestrator via a `memory?` field.
- `ai.planner()` — an LLM generates an ordered plan over your registered capabilities, then executes it step-by-step.
- `ai.spawnSubAgent()` — one-shot delegation to a fresh single-use agent with an optional per-task budget; usable from a planner step, a tool, or a workflow.
- Cost-truth contract surface across all five adapters — `Usage.reasoningTokens`, per-channel `ModelPricing`, and `ModelCallOptions.{reasoning, cacheControl}` (ignored by adapters that lack the capability).
- DX helpers — `ai.router()`, `ai.fanOut()`, `ai.batch()`, `ai.fallbackModel()`, `ai.mockRouter()`, `agent.eval()` + built-in `ai.eval.*` scorers, Vitest matchers (`registerAiMatchers()`), supervisor-level middleware, and `ai.systemPrompt.fromFile(path)`.
- Executables passed in an agent's `tools: [...]` are auto-adapted into tools (workflows / supervisors / orchestrators compose directly via `.asTool()`).

## 4.2.0

### Fixed

- No-argument tools (declared without an `input` schema) no longer crash on invocation — `tool.invoke` now skips validation when no schema is present and passes the raw input to the handler.

## 4.1.15

- Baseline — per-package changelog tracking starts at this version.
