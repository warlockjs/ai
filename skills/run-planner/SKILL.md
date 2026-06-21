---
name: run-planner
description: 'Goal-driven planning with ai.planner({...}) — an LLM GENERATES an ordered execution plan over your registered capabilities (agents / workflows / supervisors / tools), then the planner EXECUTES that plan step-by-step, threading each step output into the next, and returns the unified {data, report, usage, error} envelope with report.type "planner". A plan step may delegate via ai.spawnSubAgent({...}) — a GENERAL one-shot-agent helper (a fresh agent + optional per-task budget), covered fully in `@warlock.js/ai/run-ai-agent/SKILL.md`; it is not planner-specific and the planner engine does not require it. Triggers: `ai.planner`, `planner.execute`, `spawnSubAgent`, `PlannerConfig`, `PlannerCapability`, `PlannerResult`, `PlannerReport`, `PlannerPlan`, `PlannerStep`, `maxSteps`, `report.plan`, `report.executedSteps`; ''let the model plan the steps'', ''dynamic plan from a goal'', ''decompose a goal into capability calls'', ''spawn a sub-agent for a subtask''; typical import `import { ai } from "@warlock.js/ai"`. Skip: a FIXED known pipeline — `@warlock.js/ai/run-ai-workflow/SKILL.md`; routing one input to a specialist each turn — `@warlock.js/ai/run-supervisor/SKILL.md`; a single model + tools call — `@warlock.js/ai/run-ai-agent/SKILL.md`; competing libs `langgraph`, `crewai`.'
---

# `ai.planner()` — LLM-generated, then executed, plans

A planner turns a free-form **goal** into an ordered **plan** the LLM writes itself (referencing only the capabilities you registered), then runs that plan one step at a time through each capability's own `execute()`. Use it when you do NOT know the steps up front — the model decides the sequence.

## When to reach for it

- **`agent`** — one model + tools, single task. No multi-step decomposition.
- **`workflow`** — a FIXED pipeline you author by hand (`steps: [...]`). The steps are known at design time.
- **`supervisor`** — routes one input to the right specialist each turn; loops on a quality verdict.
- **`planner`** — the steps are NOT known in advance. The LLM generates the ordered plan from the goal, then the planner executes it. Bounded v1: strictly sequential, no DAG scheduling, no mid-plan re-planning.

## Shape

```ts
import { ai } from "@warlock.js/ai";

const research = ai.planner({
  name: "research-assistant",
  model: ai.openai.model({ name: "gpt-4o" }), // the plan-GENERATION brain
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

## Execution model (bounded v1)

1. **Generate** — the planning agent is asked for a `{ steps, summary? }` plan via a generated schema whose `capability` field is an `enum` of your capability names.
2. **Execute** — steps run **strictly in array order**. Each completed step's output is threaded into the next step's input as "Context from earlier steps". `dependsOn` on a step is advisory metadata only — recorded, not scheduled on.
3. **Finalize** — when `output` is set (factory or per-call), the LAST completed step's structured output is validated into `result.data`. A capability that should feed typed output to the planner's `output` should declare its own `output` schema (the planner reads `data`, falling back to an agent's raw `text`).

`report.type === "planner"`; `report.children[]` carries every dispatched capability report (plus the planning trip), with usage rolled up. Lazy capability loading is **deferred** — every capability is fully constructed up front.

## Failure + cancellation

`execute()` never throws — failures surface on `result.error`:

- **`PlannerPlanInvalidError`** (`PLANNER_PLAN_INVALID`, category `schema`) — empty plan or a step naming an unknown capability; also a final-output validation failure.
- **`PlannerCancelledError`** (`PLANNER_CANCELLED`, category `cancelled`) — the `AbortSignal` fired. `report.status === "cancelled"`, `report.cancelledAt` set; remaining steps are `skipped`.
- A child capability's own error (agent / tool / provider) flows through unchanged on the failing step's snapshot and as `result.error`. The planner stops at the first failed step and marks the rest `skipped`.
- **`PlannerFailedError`** is the base for the `PLANNER_*` family.

## Delegating a step with `ai.spawnSubAgent()`

A plan step can hand a bounded subtask to a fresh single-use agent with a hard spend cap via `ai.spawnSubAgent({...})`. It is **not** a planner feature — it's a general one-shot-agent helper (a fresh `ai.agent()` + an optional per-task `budget`, run once) that works identically inside a tool, a workflow step, a supervisor intent, or hand-rolled orchestration. The planner engine never calls it; it's simply a primitive a capability *you* write can reach for. Full coverage: [`@warlock.js/ai/run-ai-agent/SKILL.md`](@warlock.js/ai/run-ai-agent/SKILL.md).

## Testing

Use `MockSDK` for the planning model — script the plan as a JSON string matching `{ steps, summary? }`. Capabilities can be `mockAgent({ name, responses })`. See `src/planner/planner.spec.ts`.
