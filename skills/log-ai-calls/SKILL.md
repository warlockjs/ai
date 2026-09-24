---
name: log-ai-calls
description: 'Framework logging delegated to @warlock.js/logger — every primitive emits via the log singleton, configure channels / levels / redaction once at boot. Four-arg call convention (module, action, message, context). Triggers: `log.configure`, `log.setMinLevel`, `log.setChannels`, `ConsoleLog`, `FileLog`, `LogChannel`, `redact.paths`, `ai.agent.<name>` / `ai.workflow.<name>` / `ai.supervisor.<name>` modules; ''configure ai logging'', ''mask prompts in logs'', ''silence logs in tests'', ''capture log entries''; typical import `import { log } from "@warlock.js/logger"`. Skip: error hierarchy — `@warlock.js/ai/handle-ai-errors/SKILL.md`; competing libs `pino`, `winston`, `console.log`.'
---

# Logging — `log` from `@warlock.js/logger`

`@warlock.js/ai` does not own a logger contract. Every primitive imports the `log` singleton from [`@warlock.js/logger`](@warlock.js/logger/logger-basics/SKILL.md) directly and emits structured entries through it. Configuration — channels, levels, redaction — lives entirely on the logger.

**No `ai.config({ logger })`. No per-primitive `logger:` override.** Configure once at app boot; the framework picks it up.

## Installation — configure at boot

```ts
import { log, ConsoleLog, FileLog } from "@warlock.js/logger";

log.configure({
  channels: [
    new ConsoleLog(),
    new FileLog({ chunk: "daily" }),
  ],
  autoFlushOn: ["SIGINT", "SIGTERM", "beforeExit"],
});

log.setMinLevel("info");
```

That's it. Every agent / workflow / supervisor running in the process emits to the configured channels.

## Call convention — four positional args

Every framework log call uses the 4-arg positional form:

```ts
log.info("ai.agent", "trip.started", "agent starting trip", { tripIndex, model });
```

- **`module`** — emitting primitive, name-suffixed (`"ai.agent.<name>"`, `"ai.workflow.<name>"`, `"ai.supervisor.<name>"`); provider adapters use `"ai.openai"` etc.
- **`action`** — mirrors event names without the primitive prefix (`"trip.started"`, `"tool.called"`).
- **`message`** — human-readable summary.
- **`context`** — structured bag of diagnostic fields.

`action` strips the prefix of the corresponding event (`agent.trip.started` → `trip.started`) so grep filters and event handlers share vocabulary.

## Level mapping

| Level | Framework usage |
| --- | --- |
| `debug` | Internals (request/response bodies, token counts per trip) |
| `info` | Milestones (agent starting, agent completed) |
| `warn` | Retries, repair attempts, recoverable tool failures |
| `error` | Terminal failures surfaced via `result.error` |
| `success` | Tool-call success |

Streaming deltas are intentionally **not** logged at token granularity — trip boundaries carry the same information at readable volume.

## What gets logged

### Agent

| Action | Level | Context |
|---|---|---|
| `agent.starting` | `info` | inputLength, model, maxTrips |
| `trip.started` | `debug` | tripIndex |
| `tool.calling` | `debug` | tool name, action, tripIndex |
| `tool.called` | `success` | tool name, duration, tripIndex |
| `tool.failed` | `warn` | tool name, error code, tripIndex |
| `repair.attempting` | `warn` | tripIndex, validation issues |
| `agent.completed` | `info` | totalUsage, totalDuration, trip count |
| `agent.error` | `error` | error code, message, stack |

### Workflow

`workflow.starting` / `step.starting` / `step.completed` / `step.failed` / `workflow.completed` / `workflow.error`. Module is `ai.workflow.<name>`.

### Supervisor

`supervisor.starting` / `iteration.starting` / `router.deciding` / `router.decided` / `agent.starting` (per dispatched agent) / `iteration.completed` / `evaluate.verdict` / `supervisor.completed`. Module is `ai.supervisor.<name>`.

### Provider adapter

`ai.openai` (and future adapters) emit `request` (debug) and `response` (debug) per call, plus `error` on the wrapped `AIError`.

## Redaction

Redaction is a `@warlock.js/logger` feature — configure once on the logger, applies to every framework log automatically.

```ts
log.configure({
  redact: {
    paths: [
      "context.messages",          // prompts
      "context.input",              // user input
      "context.apiKey",             // never log this anyway, but defense-in-depth
    ],
  },
});
```

See [`@warlock.js/logger/redact-sensitive-log-fields/SKILL.md`](@warlock.js/logger/redact-sensitive-log-fields/SKILL.md) for the full redaction surface.

## Events vs. logs — two channels, one source

- **Events** are push-model (subscribers), typed payloads, per-execution lifetime — ideal for UI streaming, SSE, metrics.
- **Logs** are pull-model (written to channels), structured-string + context, persistent — ideal for grep, post-mortem.

Both fire from the same internal emit so every event produces both.

## Patterns

### Silence everything in tests

```ts
import { log } from "@warlock.js/logger";

beforeAll(() => log.setChannels([]));
```

### Capture all framework log entries in a test

```ts
import { log, LogChannel } from "@warlock.js/logger";

class Capture extends LogChannel {
  public name = "capture";
  public entries: any[] = [];
  public log(data) { this.entries.push(data); }
}

const capture = new Capture();
log.setChannels([capture]);
```

See [`@warlock.js/logger/test-logging-code/SKILL.md`](@warlock.js/logger/test-logging-code/SKILL.md) for the test patterns.

## See also

- [`@warlock.js/logger/logger-basics/SKILL.md`](@warlock.js/logger/logger-basics/SKILL.md) — logger foundations
- [`@warlock.js/logger/configure-logger/SKILL.md`](@warlock.js/logger/configure-logger/SKILL.md) — startup setup
- [`@warlock.js/logger/redact-sensitive-log-fields/SKILL.md`](@warlock.js/logger/redact-sensitive-log-fields/SKILL.md) — redaction
- [`@warlock.js/ai/handle-ai-errors/SKILL.md`](@warlock.js/ai/handle-ai-errors/SKILL.md) — what lands on the `error` channel
