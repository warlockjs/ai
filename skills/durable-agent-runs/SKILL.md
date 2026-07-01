---
name: durable-agent-runs
description: 'Mid-run crash-resume for agents AND planners — opt in with durable: { store, deleteOnComplete? } on the config, pass a stable runId to execute(), and call agent.resume(runId) / planner.resume(runId) after a crash to continue from the last settled trip / plan node. Reuses the ai.snapshot.{memory,pg,redis} stores; checkpoints per-trip (agent) / per-node (planner); completed trips + nodes never re-run their tools and usage is never double-counted; a drifted definition throws AgentDriftError / PlannerDriftError (bypass with { force: true }). Triggers: `durable`, `agent.resume`, `planner.resume`, `resume(runId)`, `runId`, `AgentSnapshot`, `PlannerSnapshot`, `AgentSnapshotStatus`, `PlannerSnapshotStatus`, `AgentDriftError`, `PlannerDriftError`, `computeAgentSignature`, `agent.signature`, `deleteOnComplete`, `defaultSnapshotStore`, `ai.snapshot.pg`, `ai.snapshot.memory`, `SnapshotStore`, `force: true`; ''resume an agent after a crash'', ''durable agent run'', ''continue a planner from where it crashed'', ''checkpoint agent state'', ''idempotent tool re-run on resume'', ''signature drift on resume''; typical import `import { ai } from "@warlock.js/ai"`. Skip: durable human-in-the-loop approval resume (ai.human.resume of a PendingInterrupt) — `@warlock.js/ai/durable-resume/SKILL.md`; supervisor/workflow iterate-mid-turn snapshot resume + the store contracts themselves — `@warlock.js/ai/manage-ai-stores/SKILL.md`; competing libs `temporal`, `inngest`, `restate`.'
---

# Durable agent + planner runs — resume from the last checkpoint

Opt-in mid-run crash-resume for the two long-running primitives. Turn it on, give the run a stable `runId`, and after a process crash `resume(runId)` re-hydrates the persisted state and continues from where it stopped — never re-issuing a settled trip's model call or re-invoking a completed node's capability.

> **Not the same as [[durable-resume]].** That skill is `ai.human.resume(interruptId, decision)` — resuming a **gated tool call** hours later after a human rules (a `PendingInterrupt` in an `InterruptStore`). *This* skill is **crash-resume of an in-flight run** (an `AgentSnapshot` / `PlannerSnapshot` in a `SnapshotStore`): the process died mid-run, you restart, and continue the same trip / plan. Different trigger (a crash, not a human), different store, different verb (`agent.resume` / `planner.resume`, not `ai.human.resume`).

## Opt in — `durable` on the config

```ts
import { ai } from "@warlock.js/ai";

const writer = ai.agent({
  name: "writer",
  model,
  tools: [searchTool, draftTool],
  durable: {
    store: ai.snapshot.pg({ client: pgPool }), // reuses the ai.snapshot.* stores
    deleteOnComplete: false,                    // default — keep for the completed-run short-circuit + audit
  },
});
```

`durable` shape (identical on the agent and planner config):

- **`store?`** — a `SnapshotStore`. Falls back to `ai.config({ defaultSnapshotStore })`. When neither resolves, snapshot writes **silently skip** and `resume()` throws.
- **`deleteOnComplete?`** — drop the snapshot once the run completes successfully. Default `false`.

**Absent `durable` ⇒ zero behavior change** — the loop starts at trip 0 / the first node, never writes a snapshot, and runs byte-for-byte as before.

## Run with a stable `runId`, then resume

The `runId` is the store key. Pass a stable one to `execute()` (or read the generated one off `result.report.runId`) so a later `resume()` can find the snapshot:

```ts
const result = await writer.execute("research X", { runId: "run-42" });

// ...process crashes mid-run, restarts...

const recovered = await writer.resume("run-42");
// continues from the next unsettled trip; `recovered.report.status === "completed"`
```

Planners are the mirror image — `durable` on the config, `runId` on `execute(goal)`, `planner.resume(runId)`:

```ts
const research = ai.planner({
  name: "research-assistant",
  model,
  capabilities: [{ name: "search", executable: searchAgent }, { name: "write", executable: writerAgent }],
  durable: { store: ai.snapshot.pg({ client: pgPool }) },
});

const first = await research.execute("compare A vs B", { runId: "plan-7" });
// ...crash...
const done = await research.resume("plan-7");
```

## Checkpoint granularity

| Primitive | Written | Contains | Resume continues at |
|---|---|---|---|
| **agent** | after every settled **trip** (`runTrip` end) | `messages`, `trips`, `toolCalls`, `usage`, resolved `systemPrompt` / `responseSchema`, `signature`, `status` | `trips.length` (the next trip index) |
| **planner** | after every settled **plan node** (`executeStep` end) | the frozen `plan`, `executedSteps` ledger, `usage`, child `children` reports, `replanCount`, `signature`, `status` | the unfinished frontier (from `executedSteps`) |

The write happens only where the persisted arrays are mutually consistent — for the agent, after every tool a trip requested has been dispatched and its result appended. A crash **mid-trip** loses only that in-flight trip (never checkpointed), which the resume re-issues cleanly. The planner **never re-calls the planning LLM** on resume — the plan is frozen on the first run; re-asking would burn tokens and risk a plan that no longer matches the ledger. Every field on both snapshots is JSON-serializable, so they round-trip through any `ai.snapshot.{memory,pg,redis}` backend verbatim.

## Idempotency — what does and doesn't re-run

```ts
// Completed run: resume is a no-op that re-returns the stored result.
const again = await writer.resume("run-42"); // runs nothing when status === "completed"
```

- **Completed trips / nodes never re-run their tools.** On agent resume, `trips.length` is the starting trip index — earlier trips' model calls are not replayed and their tool dispatches are not re-invoked. On planner resume, a completed node's capability dispatch is skipped (the sequential skip-guard / DAG re-seed derive the completed set from `executedSteps`).
- **Usage is never double-counted.** The running `usage` total is restored from the snapshot; only the newly-executed trips / nodes add to it.
- **Caveat — a crash MID-trip re-runs that trip's tools.** The in-flight trip was never checkpointed, so on resume its tools fire again. **Side-effectful tools (charging a card, sending an email) must be idempotent** — the same caller-responsibility boundary the supervisor and workflow primitives document. Guard them with your own dedupe key (e.g. `${runId}:${toolCallId}`).

## Drift — definition changed since the snapshot

Every agent / planner carries a structural `signature` (`agent.signature` — computed at factory time by `computeAgentSignature`), stamped on each snapshot. `resume()` compares the stored signature against the current definition; a mismatch throws before executing anything:

- **agent** covers: model name + provider, sorted tool names, `maxTrips`, whether a default `output` schema is set, `version`. It does **not** cover system-prompt text, middleware, per-event handlers, placeholders, or `modelOptions` — runtime knobs that don't change a resumable run's shape.
- **planner** covers: name + ordered capability names. A mid-run **re-plan is NOT drift** (the plan changed, not the definition); `replanCount` is persisted so the replan budget survives a resume.

```ts
import { AgentDriftError } from "@warlock.js/ai";

try {
  await writer.resume("run-42");
} catch (error) {
  if (error instanceof AgentDriftError) {
    // The definition changed (a tool was added, the model swapped). Either roll the
    // definition back, or — only when you've verified the change is snapshot-safe:
    await writer.resume("run-42", { force: true }); // bypasses the drift check
  }
}
```

`{ force: true }` is the escape hatch (mirror `PlannerDriftError` for planners). `resume()` also throws `AgentExecutionError` / `PlannerFailedError` when no store is configured or no snapshot exists for the `runId`.

## Pattern — a boot-drain resume loop

On restart, resume every run the store still has in flight. Snapshots carry a `status` (`"running" | "completed" | "cancelled" | "failed"`), so you only resume the live ones:

```ts
const store = ai.snapshot.pg({ client: pgPool });
const runIds = (await store.list?.()) ?? [];

for (const runId of runIds) {
  const snapshot = await store.load(runId);
  if (snapshot?.status === "running") {
    await writer.resume(runId); // completed/failed snapshots short-circuit or re-throw — skip them
  }
}
```

Pair `deleteOnComplete: true` with this loop when you don't need the completed-run audit trail — the store then holds only genuinely-unfinished runs, so the drain never touches settled ones.

## Cost + testing

- **Checkpointing cost is one store write per settled trip / node** — a `JSONB` upsert on `pg`, an in-process `Map` set on `memory`. A failed checkpoint is surfaced via logs, not thrown: it loses resume-ability from that point but never breaks an otherwise-healthy run.
- **Resume saves the tokens of every settled trip / node** — their model calls are not replayed. A completed-run resume spends nothing (it rebuilds the result from the snapshot). The planning LLM is never re-called on planner resume.
- **Test with `ai.snapshot.memory()`.** Drive `execute(input, { runId })` against a flaky model that throws once, assert the tool spy was called once, flip the failure off, `resume(runId)`, and assert (a) `status === "completed"`, (b) the tool spy count is unchanged (no re-invoke), and (c) `usage.total` counts each trip's tokens exactly once. Drift is testable by mutating the definition (add a tool) between `execute` and `resume` and asserting `AgentDriftError` — then `{ force: true }` proceeds.

## See also

- [[handle-ai-errors]] — the typed `AgentDriftError` / `PlannerDriftError` / `AgentExecutionError` / `PlannerFailedError` and how `result.error` surfaces a failed run.
- [[manage-ai-stores]] — the `ai.snapshot.{memory,pg,redis}()` factories, the `SnapshotStore` contract, dev-owned `pg` / `redis` clients, and never-auto-migrated `schema()`.
- [[persist-ai-data]] — supervisor / workflow snapshot resume (the sibling `iterate`-style durability) and the SnapshotStore migration notes.
- [[durable-resume]] — the OTHER resume: `ai.human.resume` of a gated tool call (human-in-the-loop), not a crash.
