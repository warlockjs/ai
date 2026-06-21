---
name: ai-dx-helpers
description: 'Developer-experience helpers across @warlock.js/ai — ai.batch (fan-out an executable over a dataset w/ concurrency + per-item retry), ai.fallbackModel (ordered model failover), agent.eval + ai.eval scorers + Vitest matchers (registerAiMatchers / toRouteTo / toConverge / toPassStep / toOutputShape) + ai.mockRouter, SLO/cost budget contracts (ai.middleware.budget({contract}) + readBudgetFallbackSignal), supervisor-level middleware, ai.systemPrompt.fromFile, and auto-adapt executables in tools:[]. Triggers: `ai.batch`, `BatchResult`, `ai.fallbackModel`, `FallbackModelContract`, `agent.eval`, `ai.eval`, `EvalReport`, `EvalScorer`, `ai.eval.judge`, `registerAiMatchers`, `toRouteTo`, `toConverge`, `toPassStep`, `toOutputShape`, `ai.mockRouter`, `MockSDK`, `mockAgent`, `budget({contract})`, `BudgetContract`, `maxLatencyMs`, `onViolation`, `readBudgetFallbackSignal`, `supervisor middleware`, `systemPrompt.fromFile`; ''run an agent over a list'', ''fail over to a backup model'', ''evaluate / score an agent'', ''SLO budget'', ''test a supervisor without an LLM'', ''prompt from a file''; typical import `import { ai } from "@warlock.js/ai"`. Skip: core agent lifecycle — `@warlock.js/ai/run-ai-agent/SKILL.md`; the budget/guardrail/semanticCache basics — `@warlock.js/ai/attach-ai-middleware/SKILL.md`; competing libs `promptfoo`, `langsmith`.'
---

# DX helpers — batch, fallback, eval, SLO, supervisor middleware

A grab-bag of additive 4.3.0 helpers. Each is independent — load the section you need.

## `ai.batch(executable, items, options?)` — fan-out a dataset

Runs the SAME executable (agent / workflow / supervisor / tool — anything `ExecutableContract`) N times, once per item, with bounded concurrency and per-item retry. Aggregates into the unified `ExecuteResult` envelope so a batch slots into cost dashboards exactly like a single run.

```ts
const result = await ai.batch(summarizer, articles, {
  concurrency: 4,                                   // default = items.length (all at once); <=0 → serial
  retry: { attempts: 3, backoff: "exponential" },   // workflow RetryConfig, applied per item
  onItem: (item) => log.info("batch", "item", "settled", { index: item.index }),
  signal: AbortSignal.timeout(120_000),
  sessionId: "ingest-2026-06-19",                   // lineage onto every child report
  name: "summarize-articles",
});

console.log(`${result.report.succeeded}/${result.report.total} ok`);
console.log(`${result.usage.total} tokens total`);

for (const item of result.items) {
  if (item.status === "completed") console.log(item.index, item.result?.data);
  else console.warn(item.index, item.error?.code, "after", item.attempts, "attempts");
}
```

**Isolation.** Items are independent — one item's failure (after its retries) never cancels a sibling, and **the batch never rejects as a whole** (`result.error` stays undefined). Failures live on each `BatchItemResult` (`status: "completed" | "failed" | "cancelled"`, `error`, `attempts`). `result.data` is the positional array of successful items' `.data` with `undefined` in failed/cancelled slots. Usage rolls up bottom-up (batch has zero own cost); each item's report attaches under `report.children[]` in original order. An `onItem` throw is swallowed — a progress hook never breaks the batch.

## `ai.fallbackModel(models, options?)` — ordered model failover

A drop-in `ModelContract` that wraps an ordered list and advances to the next model only on a **transient** provider error.

```ts
const model = ai.fallbackModel([
  ai.openai.model({ name: "gpt-4o" }),
  ai.anthropic.model({ name: "claude-3-5-sonnet" }),
]);

const agent = ai.agent({ model });   // hand it anywhere a model goes

// custom retry predicate or code list:
ai.fallbackModel([primary, backup], { retryOn: ["PROVIDER_RATE_LIMIT", "PROVIDER_TIMEOUT"] });
ai.fallbackModel([primary, backup], { retryOn: (error) => error instanceof ProviderError });
```

Default retryable codes: `PROVIDER_RATE_LIMIT`, `PROVIDER_TIMEOUT`, `PROVIDER_ERROR`. Auth / invalid-request / context-length / content-filter re-throw immediately (they'd fail identically downstream — retrying only burns budget). Identity/capabilities/pricing front the primary model. Usage aggregates across attempted models. Inspect `model.lastAttempts` for the failed models of the most recent call.

**Streaming caveat:** `stream()` can only fail over while no chunk has been emitted yet — once the first `delta` / `tool-call` reaches the consumer, a mid-stream failure propagates instead of restarting. It advances *instantly* (no backoff) — pair with a backoff middleware if you want delay.

## `agent.eval(options)` + `ai.eval.*` scorers — evaluate an agent

Run a suite of cases through `agent.execute()` and score each.

```ts
const report = await myAgent.eval({
  cases: [
    { name: "capital", input: "Capital of Egypt?", expected: "Cairo" },
    { name: "tone", input: "Comfort an upset user." },          // judge-scored
  ],
  scorers: [ai.eval.contains()],                                 // default scorers for cases w/o their own
  judge: { agent: judgeAgent, rubric: "Score 1.0 only if empathetic." },  // LLM-as-judge fallback
  passThreshold: 0.5,                                            // default
  onFailure: (caseResult) => snapshot(caseResult),
});

expect(report.passed).toBe(true);   // true only when EVERY case passed
report.passRate; report.meanScore; report.cases;   // drill-down
```

Built-in scorers on `ai.eval.*`: `exact()` (trimmed, case-insensitive; structured compared by canonical JSON), `contains()` (substring), `predicate(fn)` (arbitrary boolean assertion), `judge(config)` (LLM-as-judge). Scorer precedence per case: the case's own `scorers` → suite `scorers` → synthesized judge. A case with NONE throws at author time. A case passes only when the agent did not error AND every scorer passed.

## Vitest matchers + `ai.mockRouter` — test report trees

```ts
import { registerAiMatchers } from "@warlock.js/ai";
registerAiMatchers();   // once per test file (idempotent)

expect(await supervisor.execute(input)).toRouteTo("critic");        // dispatched the named intent
expect(await supervisor.execute(input)).toConverge();               // terminated cleanly on own decision
expect(await workflow.execute(input)).toPassStep("draft");          // named step completed
expect(await agent.execute(input, { output: schema })).toOutputShape(schema);  // data validates
```

The pure verdict functions (`matchConverge`, `matchOutputShape`, `matchPassStep`, `matchRouteTo`) and `AiMatchers` ship eagerly with no `vitest` coupling; only `registerAiMatchers` lazily imports `vitest` (a devDependency), so importing `@warlock.js/ai` in production never pulls in `vitest`.

`ai.mockRouter(decisions, options?)` builds a deterministic `route` callback that replays a canned sequence — one decision per supervisor iteration — for testing supervisors without an LLM router:

```ts
import { END } from "@warlock.js/ai";

ai.supervisor({
  name: "draft-then-review",
  intents: { writer, critic },
  route: ai.mockRouter(["writer", "critic", END]),
});

// branch on state, repeat the last decision until done:
ai.mockRouter(["research", (ctx) => (ctx.state.summary ? END : "research")], { onExhausted: "repeat" });
```

A decision is a literal `Next` (intent name / fan-out array / `END`) or a predicate over the live `RouteContext`. On exhaustion: `"end"` (default — terminate), `"throw"` (test failure), `"repeat"` (replay last). For a scripted LLM, use `MockSDK` (script the model output) and `mockAgent({ name, responses })` for fixed-response capabilities.

## SLO / cost budget contracts — `ai.middleware.budget({ contract })`

On top of the legacy `maxTokens` / `maxCostUSD` caps, declare a run-level SLO as data, with one global reaction:

```ts
const guard = ai.middleware.budget({
  pricing: { "gpt-4o": { inputPer1K: 0.005, outputPer1K: 0.015 } },
  contract: {
    maxCostUSD: 0.05,
    maxLatencyMs: 8_000,        // wall-clock from first execute.before to each trip.after
    maxTokens: 40_000,
    onViolation: "fallback",    // "abort" (default) hard-stops; "fallback" records a signal + continues
    fallback: (violation) => routeToCheaperModel(violation.dimension),
  },
});
```

Every clause is optional (a contract with no caps is inert). `onViolation: "abort"` throws `BudgetExceededError` at the next trip boundary; `"fallback"` does NOT abort — it records a typed `BudgetContractViolation` and fires `fallback`, letting the run continue (the middleware can't itself swap models). A latency breach has no `BudgetUnit` — its numbers surface via the error's `context.dimension`. `maxCostUSD` still needs a `pricing` entry for the running model or it degrades silently.

Read a recorded fallback signal in an outer middleware's `execute.after`:

```ts
import { readBudgetFallbackSignal } from "@warlock.js/ai";

const signal = readBudgetFallbackSignal(ctx.state);   // pass the middleware name as 2nd arg if non-default
if (signal?.dimension === "cost") await rerunOnCheaperModel();
```

## Supervisor-level middleware

The `middleware: AgentMiddleware[]` array on `ai.supervisor({...})` fires each middleware's optional `supervisor` hook map (`before` / `after` / `onError`) ONCE around the entire `execute()` / `stream()` / `resume()` run — the supervisor-level peer of an agent's `execute`-level middleware.

```ts
ai.supervisor({ name: "support", router, intents, middleware: [auditTrail] });
```

Same onion semantics as the agent pipeline: `before` runs top-down (return a `SupervisorResult` to short-circuit, throw to abort), `after` / `onError` run bottom-up. A middleware without a `supervisor` hook map is skipped — so the same builtin objects (budget, guardrail, …) can be registered on agents AND on the supervisor, each declaring whichever level applies. Each needs a unique `name` (its `ctx.state` namespace).

## `ai.systemPrompt.fromFile(path)`

Build a system prompt by reading a file **once, synchronously, at construction** — the file's UTF-8 contents seed one instruction block, so placeholders inside resolve at `resolve()` time and the result forks with further `.persona()` / `.instruction()` calls.

```ts
const prompt = ai.systemPrompt.fromFile("./prompts/support-agent.md");
const localized = prompt.instruction("Respond in {{language|English}}.");
localized.resolve({ language: "Arabic" });
```

One-shot by design (never re-read on `resolve()`). Throws `InvalidRequestError` when the file can't be read — a typo in the path fails loudly at construction instead of producing an empty prompt. `SystemPrompt.fromFile(path)` and `ai.systemPrompt.fromFile(path)` are identical.

## Auto-adapt executables in `tools: []`

An agent's `tools` array accepts a raw executable primitive (`AgentContract` / `WorkflowInstance` / `SupervisorContract` / orchestrator) directly — it is auto-adapted into a `ToolContract` at factory time. The tool manifest is derived from the executable's `name` + `description` + (optional) `inputSchema`; dispatch flows through its `execute()`.

```ts
const support = ai.supervisor({ name: "support", inputSchema: v.object({ message: v.string() }), router, intents });

const concierge = ai.agent({
  model,
  tools: [support, billingWorkflow, lookupTool],   // no .asTool() needed
});
```

`.asTool()` still works and takes precedence when you need a custom name / schema per use. For a supervisor/orchestrator, declaring `inputSchema` on the config is what lets it drop straight into `tools: []`.

## See also

- [`@warlock.js/ai/run-ai-agent/SKILL.md`](@warlock.js/ai/run-ai-agent/SKILL.md) — `agent.eval`, `tools: []`, the agent the helpers wrap
- [`@warlock.js/ai/run-supervisor/SKILL.md`](@warlock.js/ai/run-supervisor/SKILL.md) — `ai.router` / `ai.fanOut` / supervisor `middleware` / `mockRouter`
- [`@warlock.js/ai/attach-ai-middleware/SKILL.md`](@warlock.js/ai/attach-ai-middleware/SKILL.md) — budget / guardrail / semanticCache basics
- [`@warlock.js/ai/write-system-prompt/SKILL.md`](@warlock.js/ai/write-system-prompt/SKILL.md) — `systemPrompt.fromFile` in context
- [`@warlock.js/ai/pick-ai-provider/SKILL.md`](@warlock.js/ai/pick-ai-provider/SKILL.md) — `fallbackModel` wraps these adapters; cost-truth tokens
