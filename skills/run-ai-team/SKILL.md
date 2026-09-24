---
name: run-ai-team
description: 'Manager-led multi-agent teams with ai.team({...}) — transparent sugar over ai.supervisor that maps a manager → route/router, members → intents, and a gate → evaluate, returning a REAL SupervisorContract (no new loop, no new contract). Covers the built-in gate strings "quality" (review-then-fix) and "verify" (test-then-fix), a custom gate function, role mapping (roles / gateKey), and the verbatim supervisor pass-throughs (goal / output / state / maxIterations / snapshotStore / on / observe). Triggers: `ai.team`, `TeamConfig`, `TeamGate`, `TeamGateFn`, `TeamMemberValue`, `manager`, `members`, `gate`, `roles`, `gateKey`, `buildQualityGate`, `buildVerifyGate`, `SupervisorContract`, `ReportType`; ''build a team of agents'', ''manager that delegates to members'', ''review then fix loop'', ''test then fix loop'', ''quality gate for a multi-agent run'', ''report type team''; typical import `import { ai } from "@warlock.js/ai"`. Skip: routing one input to a fixed roster directly — `@warlock.js/ai/run-supervisor/SKILL.md` (team is sugar over it); durable cross-turn sessions — `@warlock.js/ai/run-orchestrator/SKILL.md`; LLM-generated plans — `@warlock.js/ai/run-planner/SKILL.md`; competing libs `crewai`, `autogen`.'
---

# `ai.team()` — manager + members + a quality gate

`ai.team(config)` is **thin, transparent sugar over `ai.supervisor`**. It builds a `SupervisorConfig` from the team-shaped config, calls `supervisor(...)`, and returns the **unchanged** `SupervisorContract<TOutput>` — the exact object `ai.supervisor` returns. So `ctx.intents.<member>.execute()`, `.asTool()`, `.resume()`, snapshots, and events all stay intact. `team()` owns no loop of its own.

The mapping:

| team field | becomes supervisor field |
| --- | --- |
| `manager` | `route` (deterministic `{ route }`) XOR `router` (an agent / `RouterEntry`) |
| `members` | `intents` |
| `gate` | `evaluate` |

Everything else passes through 1:1 — the sole exception is the report/result `type`, which is stamped `"team"` (see [Pass-throughs](#pass-throughs-verbatim-supervisor-semantics)).

## Shape

```ts
import { ai } from "@warlock.js/ai";
import { v } from "@warlock.js/seal";

const codeTeam = ai.team({
  name: "code-team",
  goal: "Ship a tested module that passes review.",
  manager: techLeadRouter,                 // an agent / RouterEntry → router; or { route } → deterministic
  members: { builder, reviewer, fixer },   // role-name → agent | workflow
  gate: "quality",                         // "quality" | "verify" | (ctx) => EvaluateResult
  output: v.object({ code: v.string() }),
  maxIterations: 6,                        // default 10 (supervisor's)
});

const { data, report } = await codeTeam.execute("Build a debounce<T> utility.");
```

A `member` is an `AgentContract` or a `WorkflowInstance` (the `TeamMemberValue` union — the autocomplete-friendly common case; callback / full-entry intent shapes still work when forwarded). The keys are both the role names the manager routes to AND the keys `ctx.intents.<role>` exposes (the supervisor escape hatch is preserved).

## The manager — `route` XOR `router`

```ts
// LLM-driven manager: an agent (or RouterEntry) → becomes SupervisorConfig.router
manager: techLeadRouter

// Deterministic manager: { route } → becomes SupervisorConfig.route
manager: { route: (ctx) => (ctx.iteration === 0 ? "builder" : "reviewer") }
```

Exactly one form is forwarded — mutually exclusive, mirroring the supervisor's own `router` XOR `route` rule. A malformed manager surfaces the existing `SupervisorFailedError` downstream.

## Gates — `"quality"` | `"verify"` | a function

A `gate` string selects a pre-built `evaluate` strategy; both desugar to a concrete `evaluate` callback that leans entirely on the already-shipped `EvaluateResult` semantics (`satisfied` terminates, `reassignTo` re-dispatches the fixer, `feedback` threads forward) — **no new termination or loop code**.

### `gate: "quality"` — review-then-fix

After each iteration's members settle and merge into supervisor `state`, the gate reads `state.approved` (the `gateKey`, default `"approved"`). If truthy → `{ satisfied: true }`; otherwise → `{ reassignTo: "fixer", feedback: String(state.notes ?? "") }`. The reviewer's feedback (`state.notes`) threads into the next iteration.

### `gate: "verify"` — test-then-fix

Identical shape but keyed on the tester's pass/fail slice `state.passed` (default `gateKey`) rather than a subjective score. On failure it re-dispatches the fixer; there is no feedback channel for a pass/fail signal, so none is threaded.

> The named member whose `output` schema writes the gate slice must produce a boolean into `gateKey`.

### A custom gate (full escape hatch)

```ts
gate: (ctx) => {
  if (ctx.state.score >= 0.9) return { satisfied: true };
  return { reassignTo: "fixer", feedback: ctx.state.review };
}
```

Supplying a `TeamGateFn` instead of a string opts out of the sugar entirely while keeping the rest of `team()`'s wiring — it forwards straight to `SupervisorConfig.evaluate` with zero wrapping.

## Role mapping — `roles` + `gateKey`

The string gates default to canonical role names. Override when your `members` keys differ:

```ts
ai.team({
  name: "qa-team",
  manager,
  members: { author, critic, patcher },
  gate: "quality",
  roles: { reviewer: "critic", fixer: "patcher" }, // map gate roles → your member keys
  gateKey: "ok",                                    // state slice the gate reads
});
```

**Construction-time validation:** when the gate is a string, the resolved `fixer` (and, for `"quality"`, the `reviewer`) role is checked against `members`. A missing role throws an authoring-style `SupervisorFailedError` (`context: { authoring: true }`) immediately — rather than silently starving until `maxIterations`.

## Pass-throughs (verbatim supervisor semantics)

`goal`, `output`, `state`, `maxIterations`, `snapshotStore`, `on`, `observe`, and `version` are forwarded unchanged. Because the returned object IS a supervisor, observability rides the same generic `Observer` seam every other flow uses (see `observe-ai-flows`), and snapshot resume works exactly as on a bare supervisor.

The one behavioural difference from a bare supervisor: a team stamps **`type: "team"`** on both its report (a first-class `ReportType`, was `"supervisor"`) and its result, so Panoptic and any `Observer` can distinguish, group, filter, and label team runs as their own type rather than folding them into plain supervisor runs. Everything else passes through 1:1.

A member callback that calls `agent.execute()` **directly** still nests `member → agent → tool` under the member span with usage rolled up — the same ambient-`RunFrame` auto-nesting as a bare supervisor. See [`@warlock.js/ai/run-supervisor/SKILL.md`](@warlock.js/ai/run-supervisor/SKILL.md).

## See also

- [`@warlock.js/ai/run-supervisor/SKILL.md`](@warlock.js/ai/run-supervisor/SKILL.md) — the primitive team desugars into (intents, route/router, evaluate, ctx.intents)
- [`@warlock.js/ai/run-orchestrator/SKILL.md`](@warlock.js/ai/run-orchestrator/SKILL.md) — wrap a team in durable cross-turn session state
- [`@warlock.js/ai/observe-ai-flows/SKILL.md`](@warlock.js/ai/observe-ai-flows/SKILL.md) — the `observe` seam a team inherits
