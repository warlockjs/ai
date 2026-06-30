---
name: observe-ai-flows
description: 'The core Observer seam — a generic, tool-agnostic observability hook every flow routes its completed ExecutionReport through. Covers the per-flow `observe?: boolean | Observer` option on ai.agent / workflow / supervisor / team, the global registry (registerObserver / getObservers / setObserveAll / isObserveAll / clearObservers), resolveObservers / notifyObservers resolution, the opt-in AgentConfig.captureMessages → AgentReport.messages full-history capture, the onConfigApplied dependency-inversion seam, and that @warlock.js/ai-panoptic is the batteries-included Observer. Triggers: `Observer`, `observe`, `registerObserver`, `getObservers`, `setObserveAll`, `isObserveAll`, `clearObservers`, `resolveObservers`, `notifyObservers`, `FlowObserveOption`, `ExecutionReport`, `captureMessages`, `AgentReport.messages`, `CapturedMessage`, `onConfigApplied`, `observeAll`; ''observe an agent run'', ''send finished reports to a collector'', ''capture the full message history'', ''observe every flow by default'', ''wire panoptic / tracing''; typical import `import { ai, registerObserver } from "@warlock.js/ai"`. Skip: structured logging of events — `@warlock.js/ai/log-ai-calls/SKILL.md`; reading the report tree shape (trips / children) — `@warlock.js/ai/run-ai-agent/SKILL.md`; per-call cost / usage rollup — `@warlock.js/ai/handle-ai-errors/SKILL.md`. The batteries-included Observer is the `@warlock.js/ai-panoptic` package.'
---

# The `Observer` seam — generic, tool-agnostic observability

Core defines a structural `Observer` and a tiny registry; it never imports any observability package (panoptic, OTel, Langfuse, …). A flow that resolves to "observed" hands its completed `ExecutionReport` to every registered observer. An observability tool **implements `Observer` and registers itself**, so `observe: true` / observe-all route reports without coupling core to the tool — the dependency inversion that keeps the two sides decoupled.

```ts
export interface Observer {
  collect(report: ExecutionReport): void | Promise<void>;
}
```

`collect` may be sync or async — the flow awaits it. A throw is **swallowed** by the flow (never breaks the run), mirroring the existing `onUsage` / `onComplete` hooks.

## Per-flow `observe` option

`observe?: boolean | Observer` (`FlowObserveOption`) is accepted on **`ai.agent`, `ai.workflow`, `ai.supervisor`, and `ai.team`** (a team forwards it verbatim to the supervisor it desugars into):

```ts
const collector: Observer = { collect(report) { exporter.send(report); } };

ai.agent({ model, observe: true });       // → the globally registered observers, even if observe-all is off
ai.agent({ model, observe: false });      // → opt out entirely, even when observe-all is on
ai.agent({ model, observe: collector });  // → a flow-LOCAL collector; only this flow's report, only to it
ai.agent({ model });                      // → undefined: follow the global observe-all flag
```

Resolution (`resolveObservers(observe)`):

- `false` → `[]` (opted out).
- `true` → the globally registered observers.
- an `Observer` object → just that one (flow-local; the global observers are skipped).
- `undefined` → the global observers when observe-all is on, otherwise `[]`.

`notifyObservers(observe, report)` routes a completed report to each resolved observer, awaiting each `collect` (so async exporters finish before the flow returns) and swallowing any throw. The object form is typed as the structural `Observer` (NOT a panoptic-specific type), so a panoptic flow-local collector — which implements `Observer` — can be passed directly.

## The global registry

```ts
import {
  registerObserver, getObservers, setObserveAll, isObserveAll, clearObservers,
} from "@warlock.js/ai";

registerObserver(collector);  // an observability tool registers ONE collector when its config is applied
getObservers();               // read-only snapshot of the registered observers (do not mutate)

setObserveAll(true);          // "observe every flow by default" — flows without their own `observe` get observed
isObserveAll();               // read the flag (default false — opt-in observability)

clearObservers();             // test-only: reset observers + the observe-all flag for spec isolation
```

`observeAll` defaults to `false` (opt-in). A flow that never sets `observe` is observed **only** when observe-all is on; individual flows still opt out with `observe: false`.

## Full-history capture — `captureMessages` → `AgentReport.messages`

Off by default. When `ai.agent({ captureMessages: true })` is set, the agent normalizes the real assembled turn array onto `AgentReport.messages` as a `CapturedMessage[]`:

```ts
const { report } = await ai.agent({ model, tools, captureMessages: true }).execute("Go");
report.messages; // CapturedMessage[] — every role (system/user/assistant/tool), every trip
```

A `CapturedMessage` is a JSON-safe projection: `{ role, content, toolCalls?, toolCallId? }` — `content` is always a string (tool results stringified), assistant turns that triggered tools carry `toolCalls`, tool-result turns carry the `toolCallId` they answer. Unlike `trips[].input` (which stubs non-first trips with `"[tool results]"`), this preserves the **real** turn array. Omitted ⇒ the field is **absent** and the report is byte-for-byte as before. Opt-in because messages can be large and sensitive (full prompts, tool inputs/outputs) — and **required for panoptic full-history capture**.

## Callback sub-agents nest in the report tree

The `ExecutionReport` an observer receives reflects **full** lineage: a supervisor / team / orchestrator callback that calls `agent.execute()` directly auto-nests `callback → agent → tool` (via an ambient `RunFrame`), so usage / cost roll up and panoptic renders the sub-agent under its callback instead of as a lone `$0` span. No observer-side change is needed — the tree arrives already nested. A team's root span carries `type: "team"` (a first-class `ReportType`, not `"supervisor"`), so observers can distinguish, group, and label team runs as their own type. See [`@warlock.js/ai/run-supervisor/SKILL.md`](@warlock.js/ai/run-supervisor/SKILL.md).

## The config seam — `onConfigApplied`

An observability tool reacts to its own augmented config slot without core importing it. Core lets tools attach an opaque slot (e.g. `panoptic?`) via declaration merging on `AIConfig`, then fires registered listeners after each `ai.config(...)` merge:

```ts
import { onConfigApplied, getAIConfig } from "@warlock.js/ai";

onConfigApplied((config) => applyPanopticConfig(config.panoptic)); // react on every config merge
applyPanopticConfig(getAIConfig().panoptic);                        // catch a pre-set config
```

A misbehaving listener's throw is swallowed (same swallow-on-throw discipline as the observer hooks). This mirrors the `Observer` registry's dependency inversion: a tool flips `setObserveAll(true)` and calls `registerObserver(...)` from inside its `onConfigApplied` listener.

## The batteries-included Observer

`@warlock.js/ai-panoptic` is the shipped, full-featured `Observer` — install it, configure it via `ai.config({ panoptic })`, and it registers its collector + (optionally) flips observe-all for you. Core stays dependency-free; this skill documents the seam panoptic plugs into.

## See also

- [`@warlock.js/ai/run-ai-agent/SKILL.md`](@warlock.js/ai/run-ai-agent/SKILL.md) — the `AgentReport` / `ExecutionReport` tree (`trips`, `children`) an observer receives
- [`@warlock.js/ai/log-ai-calls/SKILL.md`](@warlock.js/ai/log-ai-calls/SKILL.md) — event-level structured logging (vs. report-level observation)
- [`@warlock.js/ai/run-ai-team/SKILL.md`](@warlock.js/ai/run-ai-team/SKILL.md) — a team inherits `observe` through the supervisor it forwards to
