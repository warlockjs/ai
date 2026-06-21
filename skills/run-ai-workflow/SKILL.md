---
name: run-ai-workflow
description: 'Build durable resumable pipelines with ai.workflow({...}) + ai.step({...}) — lifecycle (skip / before / run|agent|parallel / output / after / nextStep), retry, parallel groups, snapshot resume. Triggers: `ai.workflow`, `ai.step`, `wf.execute`, `wf.resume`, `WorkflowContext`, `WorkflowResult`, `StepSnapshot`, `nextStep`, `onFailure`, `WorkflowDriftError`; ''build a workflow'', ''define a step'', ''resume after crash'', ''parallel steps'', ''retry with backoff''; typical import `import { ai } from "@warlock.js/ai"`. Skip: agent — `@warlock.js/ai/run-ai-agent/SKILL.md`; supervisor — `@warlock.js/ai/run-supervisor/SKILL.md`; competing libs `temporal`, `inngest`, `bullmq`.'
---

# `ai.workflow()` — static, deterministic pipelines

Second rung of the 4-primitive ladder. A named, ordered set of steps with a stable signature. Each step is exactly one of: an agent call (`agent`), a `run` function, or a parallel group (`parallel`). Compose another workflow in by wrapping it with `workflow.asTool()` and calling it from a `run` step. Durable (resumable via any `CacheDriver` from `@warlock.js/cache`), observable, cancellable.

## When NOT to use a workflow

- Unknown shape at author time → wait for `ai.planner()` (v3)
- Quality-loop until goal met → [`@warlock.js/ai/run-supervisor/SKILL.md`](@warlock.js/ai/run-supervisor/SKILL.md)
- Multi-turn conversation with persistent session → orchestrator (v2)
- Iterate a runtime list of items → `ai.batch()` utility wrapping a workflow

## Minimal shape

```ts
import { ai } from "@warlock.js/ai";
import { MemoryCacheDriver } from "@warlock.js/cache";
import { v } from "@warlock.js/seal";

ai.config({ defaultStore: new MemoryCacheDriver() });

type CatalogInput = { url: string };
type CatalogOutput = { id: string };
type CatalogState = { html?: string; catalogId?: string };

const wf = ai.workflow<CatalogInput, CatalogOutput, CatalogState>({
  name: "catalog-item",
  output: {
    extract: (ctx) => ({ id: ctx.state.catalogId ?? "" }),
    schema: v.object({ id: v.string() }),
  },
  steps: [
    ai.step<CatalogInput, CatalogState>({
      name: "fetch",
      run: async (ctx) => {
        ctx.state.html = await fetch(ctx.input.url).then(r => r.text());
      },
    }),
    ai.step<CatalogInput, CatalogState>({
      name: "extract",
      agent: extractorAgent,
      input: (ctx) => ({ prompt: `Extract from: ${ctx.state.html}` }),
      output: {
        extract: (ctx) => ctx.agentResult?.data,
        schema: itemSchema,
      },
      retry: { attempts: 3, backoff: "exponential" },
    }),
  ],
});
```

## Generics

```ts
ai.workflow<TInput, TOutput, TState, TContext>(...)
ai.step<TInput, TState, TContext>(...)
```

Order: Input/Output describe the public contract, State before Context because step bodies touch state more often. Defaults (`unknown`, `Record<string, unknown>`) let partial typing work.

## Execute — two interchangeable shapes

```ts
// canonical — mirrors agent.execute
const result = await wf.execute(
  { url: "https://..." },
  { runId: "catalog-123", signal: AbortSignal.timeout(60_000) },
);

// single-object — ergonomic alt
const result = await wf.execute({
  input: { url: "https://..." },
  runId: "catalog-123",
});
```

`WorkflowRunOptions` carries `runId`, `signal`, `on`, `context`, `sessionId`. `WorkflowDefinition.version` mirrors onto every produced report.

## `execute()` never throws

All failures funnel into `result.error`:

- `StepFailedError` / `STEP_FAILED`
- `RoutingError` / `WORKFLOW_INVALID_GOTO`
- `WorkflowDriftError` / `WORKFLOW_DRIFT`
- `WorkflowCancelledError` / `WORKFLOW_CANCELLED`
- `MaxStepsExceededError` / `WORKFLOW_MAX_STEPS`

See [`@warlock.js/ai/handle-ai-errors/SKILL.md`](@warlock.js/ai/handle-ai-errors/SKILL.md).

## Result shape

```ts
const { data, report, usage, error } = await wf.execute(input);
```

```ts
type WorkflowResult<TOutput> = {
  type: "workflow";
  data?: TOutput;            // from workflow.output.extract
  report: WorkflowReport;    // runId, signature, status, timings, per-step snapshots
  usage: Usage;              // aggregated across all agent calls
  error?: AIError;
};
```

`report.steps[name]` holds a frozen `StepSnapshot` with `output`, `status`, `attempts`, `attemptHistory`, timings, nested children for parallel groups.

## Step lifecycle

```
skip? → before? → (run | agent | parallel) → output.extract (+ schema) → after? → nextStep?
```

Exactly one of `run` / `agent` / `parallel` per step (enforced at `ai.step()` author time).

| Phase | Purpose |
| --- | --- |
| `skip` | Return `true` to skip the step. Output becomes `undefined`. `nextStep` still fires. |
| `before` | Pre-work — fetch, set state, validate. |
| `run` | Core non-agent work. |
| `agent` | Agent to execute. Takes `input(ctx)` as prompt builder. |
| `input` | Required when `agent` is set. |
| `output` | `{ extract, schema? }` — extracts the step's output. |
| `after` | Post-work — save, notify. |
| `nextStep` | Step-level routing on `completed` / `skipped`. |
| `onFailure` | Step-level recovery routing after retries exhaust. |
| `onCancel` | Cleanup if cancelled in-flight. |

Errors in `before`/`run`/`agent`/`after`/`output` are retryable. Errors in `nextStep` and `onFailure` terminate the workflow with `RoutingError`.

## Context (`ctx`)

```ts
type WorkflowContext<TInput, TState, TContext> = {
  readonly input: TInput;                         // frozen — durable cause
  readonly context: TContext;                     // frozen — per-execution
  readonly steps: Record<string, StepSnapshot>;   // frozen snapshots of COMPLETED steps
  state: TState;                                  // mutable current shared state
  readonly agentResult?: AgentResult<unknown>;    // set when current step has an agent
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly startedAt: Date;
};
```

`input`, `context`, `steps` are deep-frozen. `state` is mutable during a step and frozen into `steps[name].state` on completion.

### `input` vs `context`

- `input` answers *what* to process — persisted in the snapshot, replayed verbatim on `resume()`.
- `context` answers *who's running it* — tenancy, user, locale, traceId. **Never persisted.** Callers pass fresh on every `execute()` and `resume()`.

**Resume rule.** No fingerprinting on context. Persistence-scoping fields (e.g. `organizationId`) MUST match across resume — silent data corruption otherwise.

## State vs `steps[x].output` — performance

- **Small control data** (flags, counters) → `ctx.state`. Cheap.
- **Large artifacts** (HTML blobs, embedding vectors) → producer's `output.extract`, read via `ctx.steps[prev].output`. `ctx.state` clones on every retry attempt; `ctx.steps` clones once on step commit.

## Parallel children

```ts
ai.step({
  name: "generate",
  parallel: [
    ai.step({ name: "draft", agent: writerAgent, input, output }),
    ai.step({ name: "suggest-articles", agent: kbAgent, input, output }),
  ],
});
```

- Children share `ctx.state` — last-write-wins.
- Addressable by flat (`ctx.steps.draft`) AND nested (`ctx.steps.generate.steps.draft`) path.
- Any child fails → all siblings still complete (atomic settlement); parent's `error` becomes the first child's error.
- Checkpoint atomically after all children settle.

## Routing — `nextStep` (success) + `onFailure` (failure)

```ts
ai.step({
  name: "qa",
  agent: qaReviewerAgent,
  input,
  output,
  nextStep: (ctx) => {
    if (!ctx.agentResult?.data.approved) {
      ctx.state.qaFeedback = ctx.agentResult?.data.feedback;
      return { goto: "draft" };       // success-path route
    }
  },
  onFailure: (ctx, error) => {
    if (error.code === "PROVIDER_RATE_LIMIT") {
      return { goto: "fallbackQa" };
    }
    // void → halt with the original StepFailedError
  },
});
```

Returns: `{ goto: "stepName" }`, `{ end: true }`, or `void` (fall through / halt).

**Guards:** `maxSteps` (default 100) hard-fails with `MaxStepsExceededError`. `loopWarnAfter` (default 5) emits `workflow.loop.warning`.

## Retry

```ts
retry: {
  attempts: 3,                    // default 1 = no retry
  backoff: "exponential",         // "none" | "linear" | "exponential" | (attempt) => ms
  retryOn: (error, attempt) => true,
  onRetry: (attempt, error) => {},
}
```

Exponential defaults: 500 ms → 1 s → 2 s → 4 s → 8 s, capped at 30 s. `AbortError` short-circuits retry.

## Cancellation

```ts
const ctrl = new AbortController();
const result = wf.execute({ input, signal: ctrl.signal });
ctrl.abort("user cancelled");
```

Between-step cancellation is guaranteed. Mid-step is best-effort. `status: "cancelled"` on return with partial `report.steps`; checkpoint written before returning (resume works).

## Persistence & resume

See [`@warlock.js/ai/persist-ai-data/SKILL.md`](@warlock.js/ai/persist-ai-data/SKILL.md).

```ts
await wf.execute({ input, runId: "ticket-123" });  // fresh run
await wf.resume("ticket-123");                      // after crash
```

## Events — three-tier subscription

`workflow.starting`, `workflow.step.{starting|streaming|completed|skipped|retrying|failed}`, `workflow.loop.warning`, `workflow.cancelled`, `workflow.completed`, `workflow.error`.

Subscription order: **definition → instance → per-call** (all matching handlers fire).

Every payload carries `runId` and `rootRunId`.

## Design reference

`domains/ai/design/workflow.md` — locked spec, §1–§16 covers every rule with five PoC examples.

## See also

- [`@warlock.js/ai/run-ai-agent/SKILL.md`](@warlock.js/ai/run-ai-agent/SKILL.md) — agents inside steps
- [`@warlock.js/ai/persist-ai-data/SKILL.md`](@warlock.js/ai/persist-ai-data/SKILL.md) — snapshot resume + drift
- [`@warlock.js/ai/handle-ai-errors/SKILL.md`](@warlock.js/ai/handle-ai-errors/SKILL.md) — `WorkflowError` subclasses
