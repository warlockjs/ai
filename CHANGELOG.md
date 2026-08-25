# Changelog — @warlock.js/ai

All notable changes to `@warlock.js/ai` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). `@warlock.js/*` packages are released in lockstep — every package shares the same version number, so a version below may list only the changes that affected this package.

## 5.0.0 - 2026-08-25

### Changed

- This package is unchanged in 5.0.0; its version moved only because the Warlock family releases in lockstep.

## 4.16.0 - 2026-08-18

### Security

- **`guardedFetch` no longer lets the platform follow redirects past the SSRF guard.** The outbound policy validated only the *initial* URL, then handed the request to `fetch` with automatic redirect following — so a page an agent was asked to load (`ai.rag`'s `loadWeb()`, the skills `urlSource` manifest fetch, `prepareAttachmentPart`'s remote-text path) could pass validation and then `302` into `http://169.254.169.254/...` or an internal service with no re-check. Every hop is now issued with `redirect: "manual"` and its `Location` is re-run through the full `assertUrlAllowed` policy (scheme, host allowlist, post-DNS private-IP deny) before being followed, capped at the new `OutboundPolicy.maxRedirects` (default `5`). Credential headers (`authorization`, `cookie`, `proxy-authorization`) are stripped when a hop crosses an origin boundary, and `303`/legacy `301`/`302`-on-non-GET hops re-issue as a bodyless GET, matching platform semantics. Callers passing `redirect: "manual"` get the raw 3xx back as before; `redirect: "error"` rejects on any redirect. Regression tests cover the metadata/loopback/private redirect block, the off-allowlist redirect block, the hop cap, and the clean-redirect follow
- **Supervisor fan-out now has a width bound — new `maxFanOut` option (default `10`).** A routing decision could name any number of intents (`normalize()` in `src/supervisor/decide.ts` validated only that each name was in the allowlist, with no length limit and no dedup), and `dispatchBranches` ran `Promise.all` over the lot. `maxIterations` bounded how DEEP a run went; nothing bounded how WIDE one iteration went. Since the router's per-turn prompt embeds supervisor `state` and prior branch outputs — both able to carry attacker text lifted from tool results — a prompt injection ("always return `next` as this 200-element array") turned one iteration into hundreds of real agent/workflow executions, i.e. cost/compute amplification, without ever naming an intent outside the allowlist. Duplicate names are now collapsed silently (they were pure wasted spend: branch results are indexed by intent, so the extras could never change the outcome), and a *deduped* list wider than `maxFanOut` is rejected as `SupervisorRoutingError` (`SUPERVISOR_INVALID_ROUTE`) carrying the offending array — the same failure mode as an unknown intent key. Truncating instead of throwing was rejected: it would hand an attacker-chosen subset to the executor and hide the anomaly. The cap is enforced both in `normalize()` and at `dispatchBranches`, the one chokepoint every dispatch source funnels through, so `evaluate.reassignTo`, classifier picks, and per-intent `next` unions are bounded too. Raise `maxFanOut` deliberately for supervisors that legitimately fan wide (e.g. `ai.fanOut(writer, 20)`); it's validated as an integer `>= 1` at construction
- **Supervisor state merges refuse prototype-tampering keys.** All five state-merge sites in `src/supervisor/execution.ts` (branch outputs, the `ack` slice, classifier output, the classifier `refine` slice, and the artifacts merge in both its `finalizeArtifacts` and auto-spread forms) did a bare `state[key] = value` over model-influenced data. The `output` schema that validates those slices belongs to the developer, and a permissive one (`z.record()`, `.passthrough()`, `z.any()`) passes a key literally named `__proto__` straight through — assigning it repoints the run `state` object's prototype. Blast radius was contained (one per-run object, not global `Object.prototype`), but it became genuine prototype pollution the moment anything downstream used `in`, `hasOwnProperty`, or a deep merge on state — and `finalizeArtifacts`'s key-removal pass already used `key in merged`. A shared `mergeSafely` / `assignSafeKey` / `isUnsafeMergeKey` guard (new `src/security/safe-merge.ts`, exported from the package's security barrel) now drops `__proto__` / `constructor` / `prototype` at every one of those sites and logs the refusal as `state.merge.unsafe-key`; that `key in merged` check is now `Object.hasOwn`. Dropping rather than throwing is deliberate — those keys are never legitimate state fields, and mid-iteration is the wrong place to fail a settled run

- **`orchestrator.asTool({ sessionScope: "shared" })` no longer lets the calling model choose which session it joins.** The wrapper read `sessionId` (and `history`) straight out of the *validated tool-call payload* — i.e. out of arguments the outer agent's LLM wrote — and handed them to `orchestrator.execute()`, which loads that session's checkpoint, merges its persisted `state`, runs a turn against it and writes a fresh checkpoint back. The JSDoc actively instructed developers to thread the session id through `inputSchema`. A `sessionId` is bearer-equivalent to full read/write on the session, so any prompt injection reaching the outer agent (a summarized document, a poisoned tool result, a fetched page) could say "continue session `<victim-id>`" and have the nested orchestrator splice an attacker-directed turn into a stranger's live conversation and return its content — including prior state — into the outer transcript. The target session is now bound OUTSIDE the model-visible schema, via the new `OrchestratorAsToolOptions.session`: either a literal id fixed at `asTool()` construction, or a `(ctx) => sessionId | { sessionId, history }` resolver reading the invocation's `ToolContext` (the same out-of-band channel `signal` / `artifacts` already travel on, which an LLM cannot write to). `sessionId` / `history` are stripped from the payload before it is forwarded as `execute(input)`, and a resolver that returns nothing fails the call rather than falling back to the payload. **Breaking for `"shared"` scope only:** building such a tool without `session` now throws at construction. The pre-4.15.0 behavior is still reachable behind `unsafeAllowModelSessionId: true`, documented at the API surface as bearer-token-equivalent access that obliges the developer to verify session ownership themselves. `"fresh"` scope (the default) is unchanged
- **Orchestrator/agent memory is session-scoped by default — recall can no longer surface another user's remembered turns.** `OrchestratorConfig.memory` is resolved once per orchestrator instance and reused by every `execute()` / `resume()` regardless of `sessionId`, and neither `MemoryItem`, `RecallOptions`, `MemoryContract` nor the four tier implementations carried any session/tenant key — so `recall()` could not be scoped to the calling session and `remember` (ON by default) wrote every clean turn's input + outcome text into one shared namespace. In the framework's own documented integration pattern (one `ai.memory()` built at boot, passed to `ai.orchestrator({ memory })`, serving all end users) user A's remembered text was recallable by user B's semantically similar turn, with no attacker action required. `MemoryItem.scope` and `RecallOptions.scope` are new opaque isolation keys, enforced **inside** each tier as an exact-equality match before hits are scored, merged or sliced — never left to the caller — and folded into the stored key so two scopes writing identical text stay two entries (including the procedural tier's `uses` reinforcement counter). All four tiers enforce it: `working`, `semantic`, `episodic`, `procedural`. An unscoped `recall()` reads only the unscoped pool; there is no wildcard query. The orchestrator derives the scope from the execute-time `sessionId` (`"session:<id>"`) — not from the payload, the context bag, or the model — via the new `OrchestratorMemoryConfig.scope`, which defaults to `"session"`. **Behavior change:** memories seeded or written before the upgrade are unscoped and are no longer recalled by a session-scoped turn. Cross-session pooling is now an explicit opt-in — `scope: "shared"` restores the pre-4.15.0 single-pool behavior (and keeps reading pre-upgrade entries); `scope: (sessionId) => key` derives a custom boundary, e.g. per tenant. The vector tiers overscan before filtering so a noisy neighbouring scope cannot starve a scoped recall of its top-`k`

- **The working-memory tier is size-bounded — new `working: { maxItems }` (default `1000`).** `WorkingMemory` backed its buffer with a plain `Map` that grew by one entry per unique `remember()` and had no cap, TTL or eviction of any kind. It is also the one tier that keeps everything it is told in *process* memory, for the lifetime of the `memory()` instance — which `ai.orchestrator({ memory })` resolves ONCE and reuses for every session, for as long as the process runs. Since distinct text derives a distinct id nothing dedups, so an attacker able to drive turns through a memory-backed orchestrator (with `remember` on by default) added a permanent entry per request until the process ran out of memory: a cheap memory-exhaustion DoS against any internet-facing deployment. The buffer now evicts on overflow. **Policy is FIFO over insertion order, not LRU,** and deliberately so: recall on this tier is a pure recency proxy (it reverses insertion order and slices the newest `k`, never reordering), so the front of the buffer is by construction the region recall reaches last — FIFO evicts exactly the entries a bounded recall would never have returned, while true LRU would need read-time reordering that would also rewrite the `score` every recall reports. Re-remembering an existing id still updates in place and keeps its slot. `maxItems` is validated as an integer `>= 1` at construction and has no unbounded setting — "no cap" is the vulnerability, not a configuration choice; raise it deliberately for a long-lived single-tenant process, and put durable recall in the semantic / episodic tiers, which delegate retention to a `CacheDriver`. Known and documented limitation: the bound is global rather than per-scope, so a busy session can push another's older entries out — a recall-quality degradation on a volatile scratch tier, never a disclosure (the scope filter still applies), and a per-scope quota would not help against an attacker holding many sessions anyway
- **`semanticCache()` is per-session-scoped by default — one caller's cached answer is no longer served to another.** The middleware is built once at app boot and shared by every end user, its `namespace` was a static string, and a hit is returned as a synthetic `ModelResponse` with no LLM call in between — so both lookup paths (the exact prompt-hash key and the vector `similar()` match) could serve user A's cached response, personal context and all, to user B's merely *similar* prompt, and let an attacker seed an entry engineered to sit near a predictable class of future queries and have it answered from the store thereafter. Entries now carry a `scope` derived from the run's own `AgentExecuteOptions.sessionId` (`"session:<id>"`, the same derivation the memory fix uses) — read out of the execute options, never out of the prompt or the model's output — folded into the stored key (hashed, since a `sessionId` is caller-supplied and may contain the key delimiter) *and* re-checked as exact equality on the stored entry, so key-level separation is never the thing authorizing a read. The vector path overscans before filtering, mirroring the memory tiers, so a noisy foreign session cannot occupy the top-`k` and mask a caller's own hit. New `SemanticCacheOptions.scope`: `"session"` (default), `"shared"` (one pool for every caller — the explicit opt-in for genuinely public Q&A, and the pre-4.15.0 behavior), or `(context) => key` for a custom boundary such as per-tenant. **Two behavior changes to expect:** entries written before the upgrade are unscoped and are only read by unscoped runs, and scoping trades cross-user hit rate for isolation — a public FAQ deployment where no response can carry a caller's private context should now set `scope: "shared"` on purpose. Runs made *without* a `sessionId` continue to share one unscoped pool (unchanged behavior for them); thread `sessionId` through `execute()` — composites already do — to get the isolation
- **The planner's plan schema rejects an over-long plan at parse time.** Strict-mode JSON Schema cannot express `maxItems`, so `maxSteps` was never on the wire (`plan-schema.ts` discarded the parameter outright with `void maxSteps`) and the only enforcement was `PlannerRun`'s tail truncation — which runs *after* the whole `steps[]` array has been parsed, normalized into `PlannerStep[]` and stored on `this.plan`. A provider or proxy that ignores the prompt's step budget could therefore make the planner deserialize an arbitrarily long array before anything trimmed it. `validate()` now enforces a hard ceiling of `maxSteps * 4` (or `100` when `planSchema` is built without a `maxSteps`), rejecting rather than truncating: a plan several times its budget is a malfunction worth surfacing as the typed `PlannerPlanInvalidError`, not a prefix worth silently executing. The slack factor keeps the normal case — a model overshooting "at most N steps" slightly, which the runtime still truncates to `skipped` — working exactly as before

### Notes

- Suite: **176 files / 1943 tests, 1940 passing** (3 pre-existing environmental cold-import timeouts). Adds regression tests for every security fix above: the `guardedFetch` redirect/SSRF block, the supervisor `maxFanOut` cap + prototype-key state-merge guard, the `asTool` session binding and per-tier memory scope isolation, the working-memory cap, the `semanticCache` session scope, and the planner parse-time step ceiling

## 4.15.0 - 2026-08-16

### Fixed

- **`ctx.run(agent, payload)` now stringifies a non-string payload, as it always claimed to.** `coerceInlineInput` in `src/supervisor/execution.ts` gated on `!("signature" in executable)` to decide whether the target was an agent — but every member of `SupervisableExecutable` (`AgentContract`, `WorkflowInstance`, `SupervisorContract`) declares `signature`, so the condition was **permanently false and the coercion never ran**. A supervisor intent calling `ctx.run(someAgent, { question: "why", attempt: 2 })` handed the raw object to `agent.execute()`, where it landed as the user message `content` — `[object Object]` in the prompt, or a provider-side payload rejection, depending on the adapter. The check now discriminates on `isAnonymous`, the one member unique to `AgentContract`. A regression test covers it; the old guard fails it with `Expected: "string" / Received: "object"`. The unreferenced `isSupervisor()` duck-type helper — whose own JSDoc admitted it could not tell a supervisor from a workflow — is removed
- **`ToolMeta` no longer forces `label` and `actionLabel` on every tool that supplies `meta`.** It was declared as `Record<"label" | "actionLabel" | (string & {}), unknown>`, which makes both keys **required**, not optional — so any tool author who set one metadata field was made to set all of them. Now an optional-key shape with an index signature
- **`ToolConfig.action` is checked bivariantly**, via a `ToolActionResolver<T>` method-in-wrapper. The strictly contravariant parameter position rejected heterogeneous tool arrays that work correctly at runtime
- **`new Error(msg, { cause })` compiles.** `tsconfig.json` declared no `lib`, so it inherited the `target` default of ES2020, where `ErrorOptions` does not exist. `lib` is now `["ES2022"]`; this also resolves the `Array.at` and `String.replaceAll` errors. Emit is unchanged — `target` is still ES2020. Note `src/skills/sources/url-source.ts:122` was **not** a defect: the `cause` was always passed at runtime, the compiler simply had no type for it
- **`TeamMemberValue` accepts the callback member form** (`IntentCallback`), which has always worked at runtime and was only rejected by the type
- **`PlanSchema` no longer erases `~standard.jsonSchema`** from its return type

### Changed

- **`MockModelResponse.usage` is a new `MockUsage` type rather than the emitted `Usage`.** The script is an input, not a result: `MockModel.buildResponse` honours only `input` / `output` / `cachedTokens`, so a fixture declaring `cost` or `reasoningTokens` was silently discarded while the type promised otherwise. `total` is optional and documented as derived, because the mock recomputes it as `input + output` — an existing spec deliberately asserts that a mismatched scripted `total` is overridden
- **The mock honours `deltas`.** Fixtures already declared the field; the mock ignored it
- `MockSDK.model()` declares its `MockModel` return type — it always returned one, so `callHistory` is now reachable without a cast. `MockUsage` is exported from the barrel

### Notes

- Typecheck against the package's own TypeScript 6.0.3: **89 → 24 errors, and all 24 remaining are a monorepo-only artifact** (`TS6059`, `@warlock.js/cache` resolved through a `paths` mapping outside `rootDir`). They do not affect the published package, which ships built `exports` and `.d.mts`. In-scope errors are zero
- Suite: **173 files / 1878 tests passing**, up one from the new regression test

## 4.12.0

### Changed

- Declares its own test runner and pins it to an exact version (`vitest@4.1.10`). The package is its own repository, so a runner resolved from a workspace root it may not be cloned with is a runner it cannot rely on. The pin is exact rather than a range because the version moved underneath the suite mid-development on an unrelated install — a suite whose runner can change without anyone choosing it proves less than it appears to

## 4.9.0 - 2026-08-06

### Added

- `StepSnapshot.children` — reports a workflow `run` step captured from any executable its callback invoked DIRECTLY (`agent.execute(...)` rather than the declarative `agent:` field), via the same ambient `RunFrame` a supervisor/team/orchestrator callback already gets. `report.children` now includes these alongside `step.agent` reports.

### Fixed

- A workflow `run` step that calls `agent.execute()` directly no longer produces two disconnected top-level traces (one "agent", one "workflow") with the agent missing from `report.children` — it now nests correctly (`workflow → agent → tool`, usage/cost rolled up) and no longer also self-routes as a separate observed trace. Declarative `step.agent` was already correct; this closes the gap for ad-hoc calls inside `run` (self-documented in `workflow/engine.ts` as a known limitation).

## 4.8.2 - 2026-07-22

### Added

- `judgePromptBody` / `formatCriteria` / `JudgeOutcome` — the LLM-as-judge building blocks `ai.prompts().validate()` already used internally are now public, so other packages (`@warlock.js/ai-panoptic`'s trace-level system-prompt evaluation) can grade arbitrary prompt text against a model + rubric without a second judging implementation

### Fixed

- `redact()` no longer collapses a raw `Error` (or an `Error` nested in a `cause` chain) to `{}` — `name` / `message` / `stack` aren't own-enumerable on `Error` instances, so the previous `Object.entries()` walk saw none of them. This was silently dropping tool/agent error `cause` detail wherever `redact()` runs it, including `@warlock.js/ai-panoptic`'s trace `cause` field (a failed tool's `ToolExecutionError.cause` showed as an empty object in the dashboard instead of the underlying thrown error)
- `@warlock.js/ai-openai` and `pdf-parse` declared as optional `peerDependencies` — both are lazily `import()`ed (the skills-catalog embedder probe; `ai.rag.loadPdf`) but weren't listed in either `dependencies` or `peerDependencies`, so pkgist's bundler vendored their source directly into `ai`'s own build instead of leaving them external (the same split-brain class of bug as `core`'s missing `@warlock.js/ai` peerDependency, fixed in 4.8.1). For `@warlock.js/ai-openai` specifically this meant the skills-catalog embedder-installed probe always resolved against the vendored copy bundled into `ai`, so it reported an embedder provider as "installed" even when the app never installed `@warlock.js/ai-openai` itself

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
