---
name: durable-resume
description: 'Persist a gated tool call and resume it from another process hours later — ships in @warlock.js/ai core: `ai.human.resume(interruptId, decision, options)`, the `InterruptStore` (`ai.human.interrupt.{memory,pg,redis}()`), `PendingInterrupt`, and the `InterruptSuspendedError` suspend sentinel. Triggers: `ai.human.resume`, `resume(interruptId, decision)`, `InterruptStore`, `ai.human.interrupt.memory`, `ai.human.interrupt.pg`, `ai.human.interrupt.redis`, `interruptMemory`, `interruptPg`, `interruptRedis`, `PendingInterrupt`, `InterruptSuspendedError`, `ResumeOptions`, `ResumeResult`, `PgClientLike`, `RedisClientLike`; ''approve hours later from a webhook'', ''persist the approval request and resume in another process'', ''durable human-in-the-loop'', ''store the interrupt in Postgres/Redis'', ''re-run the agent turn once the human approves''. Typical import `import { ai, InterruptSuspendedError } from "@warlock.js/ai"`. Skip: the in-process await gate and the policy/decision shapes — `@warlock.js/ai/approve-tool-calls/SKILL.md`.'
---

# Durable resume — persist the interrupt, approve from another process

Interactive approval `await`s the operator in-process. **Durable** approval is for when the reviewer rules out-of-band — a Slack button, a webhook, hours later, in a different process. The flow: the handler **persists** the request to an `InterruptStore` and **throws** `InterruptSuspendedError` to suspend the run; the caller surfaces the `interruptId`; later, `ai.human.resume(interruptId, decision, { store })` applies the ruling.

> **v1 durable resume re-runs the turn** with the decision pre-seeded — it does **not** rehydrate an in-flight supervisor mid-call (that's the deferred v2 lift). Re-running is idempotent because the prompt and the seeded decision fully determine the gated call's outcome.

## Process A — suspend and surface the id

```ts
import { ai, InterruptSuspendedError } from "@warlock.js/ai";

const store = ai.human.interrupt.memory(); // swap for pg / redis in production

const agent = ai.agent({
  model,
  tools: [deleteAccount],
  middleware: [
    ai.human.approval({
      policy: { type: "predicate", requiresApproval: (c) => c.toolName === "deleteAccount" },
      store,
      handler: async (req) => {
        // 1. persist the pending interrupt
        await store.save({
          interruptId: req.interruptId,
          request: req,
          status: "pending",
          savedAt: new Date().toISOString(),
        });
        // 2. notify the reviewer out-of-band
        await slack.postApproval(req);
        // 3. suspend the run — the middleware recognizes its OWN sentinel
        throw new InterruptSuspendedError("Awaiting human approval", {
          interruptId: req.interruptId,
        });
      },
    }),
  ],
});

const result = await agent.execute("Delete account #88");

// execute() never throws — the suspend rides result.error:
if (result.error instanceof InterruptSuspendedError) {
  return { status: "awaiting-approval", interruptId: result.error.interruptId };
}
```

The middleware catches the **sentinel** (`instanceof InterruptSuspendedError`) and short-circuits a failed `ToolInvokeResult` carrying it, so `error.interruptId` is on `result.error`. Hand that id to the reviewer.

## Process B — resume hours later

```ts
import { ai } from "@warlock.js/ai";

// Re-run the turn with the decision pre-seeded:
const outcome = await ai.human.resume(
  interruptId,
  { type: "edit", args: { confirm: true } },
  { store, agent },
);

if (outcome.type === "applied" && outcome.result) {
  console.log(outcome.result.text); // the re-run completed with the ruling applied
}
```

`ai.human.resume(interruptId, decision, options)` loads the `PendingInterrupt`, validates the decision shape, deletes the record, and — when an `agent` is supplied — re-executes the original prompt with the decision **pre-seeded** so the gated tool call resolves to the ruling instead of pausing again. The prompt comes from `request.context.originalInput`; pass `options.input` to override (e.g. to append the reviewer's note), and `options.executeOptions` to forward history / output schema / signal to the re-run.

### Two resume shapes

| Shape | Pass | Behavior |
|---|---|---|
| **re-run** | `{ store, agent }` | Loads, deletes, re-executes the turn; `ResultResult.result` carries the `AgentResult`. |
| **apply-only** | `{ store }` (no `agent`) | Loads, validates, deletes; returns `{ type: "applied", decision }` for a caller-owned re-drive (custom transport). No turn re-run. |

### Idempotent by construction

```ts
type ResumeResult =
  | { type: "applied"; interruptId: string; decision: ApprovalDecision; result?: AgentResult }
  | { type: "already-resolved"; interruptId: string };
```

A second resume of an already-resolved (deleted) or never-raised interrupt returns `{ type: "already-resolved" }` — it never double-applies the decision or re-runs the turn. The record is deleted **before** the re-run, so even a re-run that itself raises a fresh interrupt can't collide with the one being resolved. A malformed decision (`reject` with no `reason`, `edit` with no `args`, an unknown `type`) throws a `TypeError` loudly rather than silently mis-driving the re-run.

## The `InterruptStore`

`ai.human.interrupt.{memory,pg,redis}()` build the store. The contract mirrors `@warlock.js/ai`'s `CheckpointStore` / `SnapshotStore` — `save` / `load` / `delete` / optional `list(prefix?)` / `schema()` — so a consumer already running an orchestrator can reuse the **same** pool for the interrupt table.

| Factory | Backing | Deps |
|---|---|---|
| `ai.human.interrupt.memory()` | process-local `Map` | none — zero runtime deps |
| `ai.human.interrupt.pg(options)` | one Postgres row per interrupt, keyed by `interrupt_id` | lazily imports the optional `pg` peer |
| `ai.human.interrupt.redis(options)` | one namespaced JSON value + a self-maintained id index | lazily imports the optional `redis` peer |

```ts
// Memory — dev / tests / single-process:
const store = ai.human.interrupt.memory();

// Postgres — pass a live pool (core never imports pg in that case):
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = ai.human.interrupt.pg({ client: pool });
// Once, via your migration tool — the framework never auto-migrates:
// await pool.query(store.schema());

// …or let the store build its own pool (lazily import("pg")):
const store = ai.human.interrupt.pg({ connectionString: process.env.DATABASE_URL });

// Redis — pass a connected client, or a url:
const store = ai.human.interrupt.redis({ url: process.env.REDIS_URL });
```

### Optional peers are lazy

`pg` and `redis` are **optional** peer dependencies — neither is a hard dependency. The driver is imported only inside the store that needs it, and only when you pass a `connectionString` / `url` (passing a live `client` imports nothing). If the driver is absent, a **curated install string** surfaces on first use, never a raw module-resolution stack trace at import — so a memory-only consumer always loads cleanly. `PgClientLike` / `RedisClientLike` are structural interfaces, so any compatible pool/client satisfies them.

`schema()` returns the reference DDL for the Postgres store (run it through your migration tool once) and an empty string for memory / redis, so callers treat `schema()` uniformly across drivers.

## See also

- [`@warlock.js/ai/approve-tool-calls/SKILL.md`](@warlock.js/ai/approve-tool-calls/SKILL.md) — the gate itself: the interrupt policy, the approve / reject / edit decision union, and the interactive (in-process await) handler.
- `@warlock.js/ai` — the `CheckpointStore` / `SnapshotStore` the `InterruptStore` mirrors, and the `ai.agent(...)` re-run target.
