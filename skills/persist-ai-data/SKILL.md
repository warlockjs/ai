---
name: persist-ai-data
description: 'Persistence delegated to @warlock.js/cache — workflow + supervisor snapshot resume via snapshotStore (4.3.0: now a SnapshotStore from ai.snapshot.*, ⚠ moved off raw CacheDriver), semantic cache + memory via vector-capable CacheDriver, global defaults via ai.config({defaultStore}) + ai.config({defaultSnapshotStore}). Covers drift detection + three recovery paths. Triggers: `ai.config`, `defaultStore`, `defaultSnapshotStore`, `snapshotStore`, `ai.snapshot`, `wf.resume`, `supervisor.resume`, `WorkflowSnapshot`, `SupervisorSnapshot`, `WorkflowDriftError`, `SupervisorDriftError`, `force: true`; ''resume a workflow run'', ''configure snapshot store'', ''handle signature drift'', ''wire pg vector cache''; typical import `import { ai } from "@warlock.js/ai"`. Skip: orchestrator checkpoint/snapshot store factories — `@warlock.js/ai/manage-ai-stores/SKILL.md`; cache driver catalog — `@warlock.js/cache/cache-basics/SKILL.md`; competing libs `temporal`, `inngest`.'
---

# Persistence — `@warlock.js/cache` everywhere

`@warlock.js/ai` owns no persistence primitives. Anything that needs durable state — supervisor / workflow snapshot resume, semantic cache, future memory — accepts a `CacheDriver` from `@warlock.js/cache`. The cache package ships memory / lru-memory / file / redis / pg drivers; pg adds optional `pgvector` for similarity retrieval.

## The big picture

```
┌──────────────┐        ┌─────────────────────────┐
│  ai.config   │  ───▶  │  @warlock.js/cache      │
│ defaultStore │        │  CacheDriver            │
└──────────────┘        │  (memory|redis|pg|...)  │
                        └────────────▲────────────┘
                                     │
       ┌─────────────────────────────┼─────────────────────────────┐
┌──────────────┐         ┌────────────────────┐         ┌──────────────────┐
│ supervisor   │         │   workflow         │         │  semanticCache   │
│ snapshotStore│         │  snapshotStore     │         │  store (vector)  │
└──────────────┘         └────────────────────┘         └──────────────────┘
```

## Resolution order — two separate defaults

```
// semantic cache + memory (CacheDriver):
options.store         ?? ai.config({ defaultStore })         ?? undefined

// supervisor / workflow / orchestrator snapshots (SnapshotStore):
options.snapshotStore ?? ai.config({ defaultSnapshotStore }) ?? undefined
```

`defaultStore` (a `CacheDriver`) and `defaultSnapshotStore` (a `SnapshotStore`) are independent — set whichever the consumer needs. When the relevant one is unset:
- **Snapshot consumers** silently skip writes and throw on `resume()`.
- **Semantic cache / memory** throws at construction.

## `ai.config({ defaultStore })` — set once at boot

```ts
import { ai } from "@warlock.js/ai";
import { cache } from "@warlock.js/cache";

ai.config({
  defaultStore: cache.driver("redis", { client: redisClient }),
});
```

Every consumer that doesn't supply its own `store` / `snapshotStore` picks this up. Per-declaration overrides win.

## Picking a driver

| Driver | KV | TTL | Tags | `similar()` | Fits |
|---|---|---|---|---|---|
| `memory` / `lru-memory` | ✅ | ✅ | ✅ | ✅ (brute force) | Dev / tests |
| `file` | ✅ | ✅ | ✅ | ❌ | Single-process persistence |
| `null` | no-op | no-op | no-op | `[]` | Test isolation |
| `redis` | ✅ | ✅ | ✅ | (RediSearch, separate phase) | Production KV + future similarity |
| `pg` | ✅ | ✅ | ✅ | ✅ (pgvector) | Production semantic cache |

Brute-force memory drivers carry an `O(N)` similarity scan — fine up to a few thousand entries.

## Snapshot resume — workflow + supervisor

> ⚠ **BREAKING (4.3.0): supervisor + workflow snapshot persistence moved `CacheDriver` → `SnapshotStore`.** A `snapshotStore` is now a `SnapshotStore` built with `ai.snapshot.{memory,pg,redis}()`, not a raw `cache.driver(...)`. The framework still ships a deprecated `CacheDriver` overload for ONE minor so existing wiring keeps working, but new code uses the dedicated store factories. The `defaultSnapshotStore` resolution is via `ai.config({ defaultSnapshotStore })` (a `SnapshotStore`), separate from `defaultStore` (a `CacheDriver`, still used for `semanticCache` + memory). See [`@warlock.js/ai/manage-ai-stores/SKILL.md`](@warlock.js/ai/manage-ai-stores/SKILL.md).

### Wiring (new)

```ts
import { ai } from "@warlock.js/ai";

ai.config({ defaultSnapshotStore: ai.snapshot.redis({ client }) });

const wf = ai.workflow({
  name: "ticket-processor",
  steps: [...],
  // snapshotStore optional — falls back to ai.config({ defaultSnapshotStore })
});

const sup = ai.supervisor({
  name: "support-team",
  router: routerAgent,
  intents: { triage, billing, resolver },
  // explicit override when this primitive needs a different store
  snapshotStore: ai.snapshot.pg({ client: pgPool, table: "support_runs" }),
});
```

The `SnapshotStore` is generic over its snapshot shape — it defaults to `SupervisorSnapshot`, and the workflow engine parameterizes it with `WorkflowSnapshot`; the only structural requirement is a `runId` string. `ai.snapshot.memory()` for dev/tests, `ai.snapshot.{pg,redis}()` for production (dev-owned client, never-auto-migrated `schema()`).

### Snapshot shapes

```ts
type WorkflowSnapshot = {
  runId: string;
  workflowName: string;
  signature: string;             // structural fingerprint
  version?: string;
  input: unknown;
  state: Record<string, unknown>;
  steps: Record<string, StepSnapshot>;
  next: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  savedAt: string;
};

type SupervisorSnapshot = {
  runId: string;
  supervisorName: string;
  signature: string;
  input: string | Record<string, unknown>;   // SupervisorInput
  iteration: number;                          // last *completed* iteration; -1 before any settle
  snapshots: IterationSnapshot[];
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  savedAt: string;
};
```

### Checkpoint rules

- Workflow: snapshot after every step settles. Parallel groups checkpoint atomically.
- Supervisor: snapshot after every iteration. Plus once on final completion / cancel / fail.
- Mid-step / mid-iteration crash resumes from the last completed checkpoint — partial work is **not** persisted.
- **Idempotency is the user's responsibility.** Steps and agents may re-run on resume.

## Fresh run vs. resume

```ts
const result = await wf.execute({ input, runId: "ticket-123" });
const result = await wf.resume("ticket-123");

await sup.execute("urgent", { runId: "support-7" });
await sup.resume("support-7");
```

Resume reads the snapshot, rehydrates state, continues from the snapshot's `next`.

## Signature drift detection

`signature` is a structural fingerprint computed at construction. On `resume()`, current signature is compared to the snapshot's. Mismatch throws `WorkflowDriftError` / `SupervisorDriftError` **without executing**:

```ts
{
  code: "WORKFLOW_DRIFT",
  savedSignature: "abc123…",
  currentSignature: "def456…",
  runId: "ticket-123",
  completedSteps: ["fetch", "extract"],
  pendingStep: "classify",
}
```

## Recovery paths

Three choices when drift is detected:

1. **Discard** — safest when the shape genuinely changed:

   ```ts
   await store.remove("ticket-123");
   await wf.execute({ input, runId: "ticket-123" });
   ```

2. **Force resume** — escape hatch for trivial edits you know are safe:

   ```ts
   await wf.resume("ticket-123", { force: true });
   ```

3. **Manual migration** — for changes you can mechanically translate:

   ```ts
   const snapshot = await store.get<WorkflowSnapshot>("ticket-123");
   if (snapshot) {
     snapshot.steps.newName = snapshot.steps.oldName;
     delete snapshot.steps.oldName;
     snapshot.signature = wf.signature;
     await store.set("ticket-123", snapshot);
     await wf.resume("ticket-123");
   }
   ```

## Semantic cache

```ts
ai.config({
  defaultStore: cache.driver("pg", {
    client: pgPool,
    vector: { dimensions: 1536, index: "hnsw" },
  }),
});

const myAgent = ai.agent({
  model,
  middleware: [
    ai.middleware.semanticCache({
      embedder: openai.embedder({ name: "text-embedding-3-small" }),
      threshold: 0.95,
      ttlMs: 60 * 60 * 1000,
    }),
  ],
});
```

The driver must support `similar()`. Without similarity → `CacheUnsupportedError`. See [`@warlock.js/ai/attach-ai-middleware/SKILL.md`](@warlock.js/ai/attach-ai-middleware/SKILL.md).

## See also

- [`@warlock.js/ai/manage-ai-stores/SKILL.md`](@warlock.js/ai/manage-ai-stores/SKILL.md) — `ai.snapshot.*` + `ai.checkpoint.*` store factories, schema(), drivers
- [`@warlock.js/ai/run-ai-workflow/SKILL.md`](@warlock.js/ai/run-ai-workflow/SKILL.md) — `snapshotStore` + `resume()`
- [`@warlock.js/ai/run-supervisor/SKILL.md`](@warlock.js/ai/run-supervisor/SKILL.md) — same on supervisor
- [`@warlock.js/ai/attach-ai-middleware/SKILL.md`](@warlock.js/ai/attach-ai-middleware/SKILL.md) — `semanticCache` middleware
- [`@warlock.js/ai/handle-ai-errors/SKILL.md`](@warlock.js/ai/handle-ai-errors/SKILL.md) — drift errors
- [`@warlock.js/cache/cache-basics/SKILL.md`](@warlock.js/cache/cache-basics/SKILL.md) — driver catalog
