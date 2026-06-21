---
name: run-supervisor
description: 'Multi-intent routing with ai.supervisor({...}) — classifier (iter-0 dispatch), router agent OR route callback, intents as agents / workflows / callbacks, fan-out, evaluate quality loop, ack receptionist, supervisor-level middleware. Triggers: `ai.supervisor`, `ai.router`, `ai.fanOut`, `supervisor.execute`, `supervisor.resume`, `intents`, `router`, `route`, `classifier`, `evaluate`, `ack`, `artifactsSchema`, `middleware`, `END`, `ctx.intents.X.execute`; ''route one input across specialists'', ''multi-intent dispatch'', ''fan-out then evaluate'', ''classifier then router'', ''supervisor middleware'', ''self-consistency / voting''; typical import `import { ai } from "@warlock.js/ai"`. Skip: durable multi-turn sessions — `@warlock.js/ai/run-orchestrator/SKILL.md`; fixed pipelines — `@warlock.js/ai/run-ai-workflow/SKILL.md`; single agent — `@warlock.js/ai/run-ai-agent/SKILL.md`; competing libs `langgraph`, `crewai`.'
---

# `ai.supervisor()` — multi-intent routing

A supervisor takes one input, picks which intent(s) handle it, runs them, optionally evaluates the result, and either terminates or iterates. Stateless between runs unless you wire `snapshotStore` for resume.

## When to reach for it

- **`agent`** — one model + tools, single task. Doesn't fit when the right specialist depends on the input.
- **`workflow`** — fixed step order. Doesn't fit when routing decisions need an LLM or vary per request.
- **`supervisor`** — when the right specialist is decided per-call and you may iterate to a goal.
- **`orchestrator`** — when the *session* matters: long-running conversations with durable cross-turn state, history windowing/compaction, and mid-turn resume. See [`@warlock.js/ai/run-orchestrator/SKILL.md`](@warlock.js/ai/run-orchestrator/SKILL.md).

## Three dispatch surfaces

| | When it fires | Iterations |
| --- | --- | --- |
| `classifier` | iter-0 prelude — picks the FIRST intent | 1 |
| `router` | iter 0+ (no classifier); iter 1+ (with classifier) | 1..maxIterations |
| `route` | iter 0+ (no classifier); iter 1+ (with classifier) | 1..maxIterations |

`router` and `route` are mutually exclusive. `classifier` composes with either. Classifier alone (no router/route) → terminates after iter 0.

`classifier` is mutually exclusive with `initialAgent`.

Quick decision tree:
- Pure classification → `classifier` alone.
- Multi-step reasoning → `router` + `intents` with rich descriptions.
- Deterministic routing → `route` callback.
- Classify-then-iterate → `classifier` + `router`/`route`.

## Two routing modes — `route` XOR `router`

### Deterministic — `route(ctx)`

```ts
const triageBot = ai.supervisor({
  name: "triage",
  intents: { billing, shipping, returns },
  route: (ctx) => {
    const text = typeof ctx.input === "string" ? ctx.input.toLowerCase() : "";
    if (text.includes("refund")) return "billing";
    if (text.includes("ship")) return "shipping";
    return "returns";
  },
});
```

`route` returns `string | string[] | typeof END`. Array → fan-out.

### LLM-driven — `router` agent

```ts
const routerAgent = ai.agent({
  output: v.object({ next: v.string(), reasoning: v.string() }),
  // ...
});

const supportBot = ai.supervisor({
  router: routerAgent,
  intents: { billing, shipping, returns, escalate },
  evaluate: (ctx) =>
    Object.values(ctx.result).some((b: any) => b.data?.resolved)
      ? { satisfied: true }
      : undefined,
});
```

The router agent's output MUST include `next: string | string[] | typeof END`; `reasoning: string` is optional but recommended.

`evaluate` pairs with both `router` AND `route` — state-driven termination is useful in either dispatch mode.

#### `ai.router()` — skip the boilerplate

`ai.router({ model, intents })` builds the routing agent for you: it generates the `{ next, reasoning }` output schema (with the intent names + `END` baked in as a JSON-Schema `enum`) and auto-writes the routing system prompt listing every intent + description. Pass the **same** `intents` object you pass to `ai.supervisor()`.

```ts
const intents = { billing, shipping, returns, escalate };

const supportBot = ai.supervisor({
  router: ai.router({
    model,
    intents,
    systemPrompt: "You coordinate a customer-support team.", // optional framing on top
  }),
  intents,
});
```

The result is a plain `AgentContract` — usable standalone or as `router`. Hand-writing the agent (above) still works; `ai.router()` is the shortcut.

#### `ai.fanOut()` — voting / self-consistency

`ai.fanOut(unit, n)` spreads one agent/workflow into `n` distinctly-keyed intent entries (`writer1..writerN`) so the supervisor can dispatch them in parallel and a downstream intent can pick the best/majority answer. Spread it into `intents`:

```ts
ai.supervisor({
  intents: {
    ...ai.fanOut(writer, 3),                                   // writer1, writer2, writer3
    vote: { run: pickMajority, description: "Choose the majority answer." },
  },
  route: (ctx) => (ctx.iteration === 0 ? ["writer1", "writer2", "writer3"] : "vote"),
});
```

Each key references the same underlying unit; the description defaults to the unit's. Override the key base with `{ keyPrefix }` and the per-entry text with `{ description }`.

## The `intents` map — five accepted shapes

```ts
intents: {
  billing:  billingAgent,                                       // (a) AgentContract
  escalate: escalationWorkflow,                                 // (b) WorkflowInstance
  refund:   async (ctx) => ({ refundId: await callRefundAPI(ctx.input) }), // (c) callback
  triage: {                                                     // (d) agent entry
    agent: triageAgent,
    description: "First-pass classifier",
    placeholders: (ctx) => ({ ticket: ctx.input }),
    output: v.object({ category: v.string() }),
  },
  cancel: {                                                     // (e) callback entry
    run: async (ctx) => ({ cancelledId: await cancelOrder(ctx.input) }),
    description: "Cancel on customer request",
    output: v.object({ cancelledId: v.string() }),
  },
}
```

Runtime detects shape in order: `function → "run" in value → "agent" in value → instanceof`. Mixed dispatch fields (`{ agent, run }` together) throw at construction.

**Under a router**, every intent MUST have a non-empty `description` so the LLM has signal. Bare callback shorthand has no description — upgrade to `{ run, description }` under a router.

## State model

A supervisor builds up typed `state` across iterations. Each intent contributes a slice; final state validates against the supervisor's `output` schema.

```ts
type RefundOutput = { category: string; order?: { id: string }; reply: string };

const refundSupervisor = ai.supervisor<RefundOutput>({
  name: "refund-support",
  output: outputSchema,
  intents: {
    classify: { agent: classifierAgent, output: v.object({ category: v.string() }) },
    lookupOrder: {
      run: async (ctx) => ({ order: await ordersRepo.find(extractId(ctx.input)) }),
    },
    compose: { agent: replyAgent, output: v.object({ reply: v.string() }) },
  },
  router: routerAgent,
  evaluate: (ctx) => (ctx.state.reply ? { satisfied: true } : undefined),
});
```

Each branch's output strip-merges into state per its declared `output` schema. Last-write-wins on fan-out conflict (warning logged).

## Per-intent `next` — skip the router

```ts
intents: {
  classify: {
    agent: classifierAgent,
    next: (ctx) => ctx.state.category === "refund" ? "lookupOrder" : "escalate",
  },
  lookupOrder: {
    run: async (ctx) => ({ order: await ordersRepo.find(extractId(ctx.input)) }),
    next: (ctx) => ctx.state.order ? "compose" : "escalate",
  },
  compose: { agent: replyAgent, next: () => END },
}
```

Returns: `string` (intent name), `string[]` (fan-out), `END` (terminate), `undefined` (fall back to router). Order of authority: `evaluate` → `intent.next` → `router/route`.

## Stream-mode intents

For chat-style prose replies, opt out of structured-output coercion:

```ts
intents: {
  smalltalk: {
    agent: smalltalkAgent,
    mode: "stream",
    streamTo: "reply",   // raw text → state.reply
  },
}
```

Token deltas surface as `supervisor.agent.streaming`. `mode: "stream"` + `output` together throws — they're mutually exclusive. Stream mode is agent-only (workflows can't stream this way).

## `ack` — fast preamble

When the router agent / first specialist takes 5+ seconds and users feel it:

```ts
ack: (ctx) => ({ ack: "Got it, one moment..." })  // bare callback
ack: { run: (ctx) => ({ ack: pickHedge(ctx.input) }), output: v.object({ ack: v.string() }) }
ack: { agent: tinyAckAgent, placeholders: (ctx) => ({ tier: ctx.context.customerTier as string }) }
```

Fires on iter-0 only, in parallel with the routing decision. **Same-model trap:** if ack uses the same model+provider as the router, ack often takes longer than the router. The callback forms (1+2) are right for the common case.

## Classifier — `classifier`

Iter-0 prelude. Output locked to `{ intent, reasoning?, confidence? }`.

```ts
classifier: classifyAgent
// or with refine:
classifier: {
  agent: classifyAgent,
  refine: (ctx) => {
    const { confidence } = ctx.result.data;
    if ((confidence ?? 1) < 0.7) return { intent: "fallback" };
    return undefined;
  },
}
```

`refine` shapes: `undefined` (keep), `END` (halt), `{ intent: "x", ...slice }` (override + merge), `{ ...slice }` (keep intent, merge).

LLM-reported `confidence` is poorly calibrated — use it as a soft signal alongside heuristics.

## Tool artifacts — `ctx.artifacts`

Tools mutate `ctx.artifacts`; supervisor merges into `state` at iteration end.

```ts
ai.supervisor({
  artifactsSchema: v.object({ blocks: v.array(blockSchema).optional() }),
  finalizeArtifacts: (state, artifacts) => ({
    ...state,
    blocks: [...(state.blocks ?? []), ...(artifacts.blocks ?? [])],
  }),
});
```

Default merger — auto-spread (`{...state, ...artifacts}`). `finalizeArtifacts` for concat / dedupe across iterations. Bag resets every iteration.

## Callback intents — `ctx.intents.X.execute()` + `ctx.run` / `ctx.stream`

```ts
intents: {
  "special-refund": async (ctx) => {
    if ((ctx.input as { amount: number }).amount > 1_000) {
      await ctx.intents["audit-log"].execute();   // dispatch registered intent
    }
    return await callRefundAPI(ctx.input);
  },

  // Inline (non-registered) execution
  classify: async (ctx) => {
    const { data } = await ctx.run(classifierAgent, ctx.input);
    return { category: (data as { label: string }).label };
  },

  chatInline: async (ctx) => {
    const stream = ctx.stream(someAgent, enrich(ctx.input));
    const final = await stream.result;
    return { reply: final.text };
  },
}
```

Cycle protection: per-branch call stack. Re-entry on same intent → `SUPERVISOR_DISPATCH_CYCLE`.

## Per-call options

```ts
await supportBot.execute(message, {
  context: { userId, db, traceId },   // request-scoped bag, never persisted
  history: priorMessages,              // Message[] forwarded to router + agents
  sessionId: "sess_user_42",           // stamps onto every report node
  signal: AbortSignal.timeout(60_000),
  runId: "support-2026-04-26-7",       // for snapshot resume
});
```

`history` precedence: per-call → factory `config.history`. Slice with `historyWindow.{router,agents,ack}` (default ack = 0, router/agents = unbounded) or per-entry `history(ctx)` override.

## Supervisor-level middleware

`middleware: AgentMiddleware[]` fires each middleware's optional `supervisor` hook map (`before` / `after` / `onError`) ONCE around the whole `execute()` / `stream()` / `resume()` run:

```ts
ai.supervisor({ name: "support", router, intents, middleware: [auditTrail] });
```

Same onion semantics as the agent pipeline: `before` top-down (return a `SupervisorResult` to short-circuit, throw to abort), `after` / `onError` bottom-up. A middleware without a `supervisor` hook map is skipped — the SAME builtin objects (budget, guardrail, …) can be registered on agents AND here, each declaring whichever level applies. Each needs a unique `name`. See [`@warlock.js/ai/attach-ai-middleware/SKILL.md`](@warlock.js/ai/attach-ai-middleware/SKILL.md).

## Iteration model

1. Router/route picks `next` (or `END`).
2. Picked intents dispatch (parallel for fan-out).
3. `evaluate` (if provided) inspects results.
4. If satisfied or `END` → terminate. Otherwise → loop.

Hard cap via `maxIterations` (default 10). Hitting cap surfaces `MaxIterationsError`.

## Streaming

```ts
const stream = supportBot.stream(message);

for await (const event of stream) {
  if (event.type === "supervisor.agent.streaming") {
    process.stdout.write(event.delta);
  }
}

const result = await stream.result;
```

Token-level streaming requires the dispatched agents to be streamed (supervisor calls `agent.stream()` internally). Callbacks don't stream tokens.

## Snapshot resume

```ts
import { ai } from "@warlock.js/ai";
import { cache } from "@warlock.js/cache";

ai.config({ defaultStore: cache.driver("redis", { client }) });

await supportBot.execute(message, { runId: "support-7" });   // fresh
await supportBot.resume("support-7");                          // after crash
```

Signature drift detection throws `SupervisorDriftError` on shape mismatch — `force: true` bypasses. See [`@warlock.js/ai/persist-ai-data/SKILL.md`](@warlock.js/ai/persist-ai-data/SKILL.md).

## `asTool()` — supervisor as a tool

```ts
const supportTool = supportBot.asTool({
  description: "Route a customer support request to the right specialist",
  inputSchema: v.object({ message: v.string() }),
});

const escalationAgent = ai.agent({ model, tools: [supportTool] });
```

## Design reference

`domains/ai/design/supervisor.md` — full design rationale.

## See also

- [`@warlock.js/ai/run-ai-agent/SKILL.md`](@warlock.js/ai/run-ai-agent/SKILL.md) — dispatchable units
- [`@warlock.js/ai/run-ai-workflow/SKILL.md`](@warlock.js/ai/run-ai-workflow/SKILL.md) — when steps are known up front
- [`@warlock.js/ai/persist-ai-data/SKILL.md`](@warlock.js/ai/persist-ai-data/SKILL.md) — `snapshotStore` + resume
- [`@warlock.js/ai/attach-ai-middleware/SKILL.md`](@warlock.js/ai/attach-ai-middleware/SKILL.md) — `semanticCache` fits under each agent's middleware
- [`@warlock.js/ai/define-ai-tool/SKILL.md`](@warlock.js/ai/define-ai-tool/SKILL.md) — tool artifacts side-channel
