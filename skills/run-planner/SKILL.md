---
name: run-planner
description: 'Goal-driven planning with ai.planner({...}) — an LLM GENERATES an ordered execution plan over your registered capabilities (agents / workflows / supervisors / tools), then the planner EXECUTES it, threading each step output into the next, and returns the unified {data, report, usage, error} envelope with report.type "planner". Supports DAG scheduling (dag:true + maxConcurrency off dependsOn), adaptive re-planning (replan:{maxReplans} + the onStep continue/abort/replan directive), and plan-only / approval (mode:"plan-only" → status "awaiting-approval" → approvedPlan). A plan step may delegate via ai.spawnSubAgent({...}) — a GENERAL one-shot-agent helper covered in `@warlock.js/ai/run-ai-agent/SKILL.md`; it is not planner-specific. Triggers: `ai.planner`, `planner.execute`, `spawnSubAgent`, `PlannerConfig`, `PlannerCapability`, `PlannerResult`, `PlannerReport`, `PlannerPlan`, `PlannerStep`, `PlannerStepDirective`, `PlannerPlanInvalidError`, `maxSteps`, `dag`, `maxConcurrency`, `dependsOn`, `replan`, `onStep`, `mode`, `approvedPlan`, `awaiting-approval`, `report.plan`, `report.executedSteps`; ''let the model plan the steps'', ''dynamic plan from a goal'', ''run independent steps in parallel'', ''re-plan when a step fails'', ''generate a plan for approval before running it''; typical import `import { ai } from "@warlock.js/ai"`. Skip: a FIXED known pipeline — `@warlock.js/ai/run-ai-workflow/SKILL.md`; routing one input to a specialist each turn — `@warlock.js/ai/run-supervisor/SKILL.md`; a single model + tools call — `@warlock.js/ai/run-ai-agent/SKILL.md`; competing libs `langgraph`, `crewai`.'
---

# `ai.planner()` — LLM-generated, then executed, plans

A planner turns a free-form **goal** into an ordered **plan** the LLM writes itself (referencing only the capabilities you registered), then runs that plan one step at a time through each capability's own `execute()`. Use it when you do NOT know the steps up front — the model decides the sequence.

## When to reach for it

- **`agent`** — one model + tools, single task. No multi-step decomposition.
- **`workflow`** — a FIXED pipeline you author by hand (`steps: [...]`). The steps are known at design time.
- **`supervisor`** — routes one input to the right specialist each turn; loops on a quality verdict.
- **`planner`** — the steps are NOT known in advance. The LLM generates the ordered plan from the goal, then the planner executes it. Sequential by default; opt into **DAG** scheduling, **adaptive re-planning**, and **plan-only / approval** as needed (below).

## Shape

```ts
import { ai } from "@warlock.js/ai";
import { OpenAISDK } from "@warlock.js/ai-openai";

const openai = new OpenAISDK({ apiKey: process.env.OPENAI_API_KEY! });

const research = ai.planner({
  name: "research-assistant",
  model: openai.model({ name: "gpt-4o" }), // the plan-GENERATION brain
  capabilities: [
    { name: "search", description: "Search the web for sources", executable: searchAgent },
    { name: "summarize", description: "Summarize text into bullet points", executable: summarizer },
    { name: "write", description: "Draft a final report", executable: writerAgent },
  ],
  maxSteps: 6, // hard cap; steps beyond it are recorded as "skipped"
});

const { data, report, usage, error } = await research.execute("Compare React vs Vue in 2026");

console.log(report.plan?.summary);          // the LLM's one-line strategy
for (const step of report.executedSteps) {  // forensic, in execution order
  console.log(step.step.capability, step.status);
}
```

- `model` builds an internal planning agent with a generated plan-prompt baked on. **Mutually exclusive** with `planner`.
- `planner` lets you bring your own fully-configured planning agent (custom prompt, middleware). The planner injects the plan schema as that agent's per-call `output`.
- A `capability` is `{ name, description, executable }`. The `name` is what the LLM references per step; the `description` is what it reads to pick. `executable` is any `ExecutableContract` (agent / workflow / supervisor / tool).

## Execution model

1. **Generate** — the planning agent is asked for a `{ steps, summary? }` plan via a generated schema whose `capability` field is an `enum` of your capability names. Each `PlannerStep` is `{ capability, input, id?, reason?, dependsOn? }`.
2. **Execute** — by default steps run **strictly in array order**; each completed step's output is threaded into the next step's input as "Context from earlier steps". (Set `dag: true` to schedule on `dependsOn` instead — below.)
3. **Finalize** — when `output` is set (factory or per-call), the LAST completed step's structured output is validated into `result.data`. A capability that should feed typed output to the planner's `output` should declare its own `output` schema (the planner reads `data`, falling back to an agent's raw `text`).

`report.type === "planner"`; `report.children[]` carries every dispatched capability report (plus the planning trip), with usage rolled up. `report.executedSteps` is the authoritative per-step record (`PlannerStepSnapshot[]`). Lazy capability loading is **deferred** — every capability is fully constructed up front.

## DAG scheduling — `dag: true` + `maxConcurrency`

Run independent steps in parallel instead of array-order:

```ts
const research = ai.planner({
  name: "research",
  model,
  capabilities,
  dag: true,            // build a DAG from each step's `id` / `dependsOn`
  maxConcurrency: 4,    // max steps in flight at once. default 4
});
```

With `dag: true` the planner builds a DAG from step `id` / `dependsOn`, runs each **ready level concurrently** (up to `maxConcurrency`), and feeds each step **only its dependencies' outputs** (not the whole prior transcript). A **cycle** or a `dependsOn` naming an unknown step raises a typed `PlannerPlanInvalidError` **before any step runs**. Default `false` ⇒ the strict array-order loop, byte-for-byte unchanged (where `dependsOn` is advisory-only metadata).

## Adaptive re-planning — `replan: { maxReplans }` + `onStep`

When set, a **failed step** (or a `replan` verdict from the `onStep` hook) **revises the REMAINING plan** instead of aborting — re-asking the planning agent for a fresh plan seeded with the executed-step digest plus the feedback. Bounded by `maxReplans`; on exhaustion the run ends with the last failure.

```ts
const planner = ai.planner({
  name: "adaptive",
  model,
  capabilities,
  replan: { maxReplans: 2 },
});

await planner.execute(goal, {
  onStep: (snapshot, plan) => {
    // fired after EACH step settles (both the sequential and the DAG path)
    if (snapshot.status === "completed" && looksWrong(snapshot.output)) {
      return { type: "replan", feedback: "The summary missed the pricing section." };
    }
    // return nothing / { type: "continue" } to proceed; { type: "abort" } to stop
  },
});
```

The `onStep` directive (`PlannerStepDirective`):

- `{ type: "continue" }` (or returning nothing) — proceed.
- `{ type: "abort" }` — stop; remaining steps recorded `skipped` (exactly as a failure aborts).
- `{ type: "replan"; feedback }` — re-plan the remainder, seeded with the digest + `feedback`. **A `replan` directive with no `replan` config is treated as `continue`** (no-op). Default off ⇒ a failure aborts exactly as before.

## Plan-only / approval — `mode: "plan-only"` + `approvedPlan`

Generate (and validate) a plan, return it for human sign-off, then execute the approved plan in a follow-up call:

```ts
// 1. Generate WITHOUT executing.
const draft = await planner.execute(goal, { mode: "plan-only" });
// draft.report.status === "awaiting-approval"; draft.plan carries the generated PlannerPlan.

// 2. (human reviews draft.plan) ... then execute it verbatim.
const final = await planner.execute(goal, { approvedPlan: draft.plan! });
```

- `mode: "plan-only"` generates + validates the plan and returns **without executing** — `report.status === "awaiting-approval"` (a planner-specific NON-terminal status) and `result.plan` carries the generated plan.
- `approvedPlan` executes that exact plan, **skipping plan generation entirely**. It is still validated against the **live** capabilities, so a stale plan naming a capability the planner no longer has surfaces a `PlannerPlanInvalidError`.
- `mode: "plan-only"` **with** `approvedPlan` is contradictory — `approvedPlan` wins (the plan executes).

## Failure + cancellation

`execute()` never throws — failures surface on `result.error`:

- **`PlannerPlanInvalidError`** (`PLANNER_PLAN_INVALID`, category `schema`) — empty plan, a step naming an unknown capability, a DAG cycle, a `dependsOn` naming an unknown step, a stale `approvedPlan`, or a final-output validation failure.
- **`PlannerCancelledError`** (`PLANNER_CANCELLED`, category `cancelled`) — the `AbortSignal` fired. `report.status === "cancelled"`, `report.cancelledAt` set; remaining steps are `skipped`.
- A child capability's own error (agent / tool / provider) flows through unchanged on the failing step's snapshot and as `result.error`. The planner stops at the first failed step and marks the rest `skipped`.
- **`PlannerFailedError`** is the base for the `PLANNER_*` family.

## Delegating a step with `ai.spawnSubAgent()`

A plan step can hand a bounded subtask to a fresh single-use agent with a hard spend cap via `ai.spawnSubAgent({...})`. It is **not** a planner feature — it's a general one-shot-agent helper (a fresh `ai.agent()` + an optional per-task `budget`, run once) that works identically inside a tool, a workflow step, a supervisor intent, or hand-rolled orchestration. The planner engine never calls it; it's simply a primitive a capability *you* write can reach for. Full coverage: [`@warlock.js/ai/run-ai-agent/SKILL.md`](@warlock.js/ai/run-ai-agent/SKILL.md).

## Testing

Use `MockSDK` for the planning model — script the plan as a JSON string matching `{ steps, summary? }`. Capabilities can be `mockAgent({ name, responses })`. See `src/planner/planner.spec.ts`.
