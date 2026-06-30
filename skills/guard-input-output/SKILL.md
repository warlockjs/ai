---
name: guard-input-output
description: 'Build the composed guardrail middleware with @warlock.js/ai-guard and wire it into an agent — `ai.guardrail({ input, output, tool, toolNames, escalation })`. Triggers: `ai.guardrail`, `guard`, `GuardOptions`, `GuardrailVerdict`, `GuardrailDetector`, `GuardrailPhase`, `GuardrailMatch`, `GuardrailViolationError`, `ai.guardrail.topic`, `ai.guardrail.injection`, `topicFilter`, `injectionDetector`, `toolNames`, `forTool`; ''add a guardrail to my agent'', ''block prompt injection'', ''filter banned topics'', ''guard agent input and output'', ''stop the model leaking data into a tool call'', ''scope a detector to one tool''; typical import `import "@warlock.js/ai-guard"` (registers `ai.guardrail`) or `import { guard } from "@warlock.js/ai-guard"`. Skip: PII detection/redaction specifically — `@warlock.js/ai-guard/detect-and-redact-pii/SKILL.md`; routing a block to a human — `@warlock.js/ai-guard/escalate-block-to-human/SKILL.md`; the core middleware pipeline / hook contract — `@warlock.js/ai/run-ai-agent/SKILL.md`.'
---

# Guard agent input, output, and tool args

`ai.guardrail(...)` is a **middleware factory**. It produces one `AgentMiddleware` that runs your detectors at three hook points and maps each verdict onto the agent pipeline's existing throw / return / record mechanics. Importing the package registers the verb (and its attached detector factories) on the shared `ai` namespace:

```ts
import { ai } from "@warlock.js/ai";
import "@warlock.js/ai-guard"; // registers ai.guardrail + ai.guardrail.pii/.topic/.injection/.moderation

const policy = ai.guardrail({
  name: "compliance",
  input: [ai.guardrail.injection({ onMatch: "block" })],
  output: [ai.guardrail.topic({ deny: [/medical advice/i, "diagnosis"], onMatch: "block" })],
});

const agent = ai.agent({ model, middleware: [policy] });
```

A named-export form is available for callers who prefer not to rely on the augmented namespace:

```ts
import { guard, topic, injection } from "@warlock.js/ai-guard";
const policy = guard({ input: [injection({ onMatch: "block" })] });
```

## The three phases

| Phase | Hook | Inspected text | Set with |
|---|---|---|---|
| **input** | `trip.before` | the outbound prompt (`extractUserText(ctx.messages)`) | `input: [...]` |
| **output** | `trip.after` | `response.content` | `output: [...]` |
| **tool** | `tool.before` | `JSON.stringify(toolArgs)` | `tool: [...]` |

Each phase array runs its detectors in **registration order**; the first non-`allow` verdict decides the action for that phase (short-circuit). A phase you don't configure is inert — a guard with no detectors is a no-op middleware.

## The verdict model

A detector inspects text and returns a `GuardrailVerdict`, discriminated by `type` (never `kind`):

| `type` | Effect |
|---|---|
| `allow` | Pass to the next detector. |
| `redact` | Rewrite the inspected text and continue — **output phase only** (see limitation below). |
| `block` | Short-circuit with the existing `GuardrailViolationError`. |
| `flag` | Pass, but append a `FlagRecord` into `ctx.state` under `<name>.flags` for a downstream observer (panoptic, the caller). |

`agent.execute()` **never throws** — a `block` surfaces on `result.error` as a `GuardrailViolationError`, exactly like every other `AIError`. Branch on it after the run:

```ts
const result = await agent.execute(userInput);

if (result.error instanceof ai.errors.GuardrailViolationError) {
  // result.error.phase is "input" | "output" | "tool"
  // result.error.reason / result.error.guardrail carry the detail
}
```

## Built-in detectors

Three zero-dependency detectors ship (a fourth, `moderation`, is an optional `openai` peer — see [`detect-and-redact-pii/SKILL.md`](@warlock.js/ai-guard/detect-and-redact-pii/SKILL.md)):

- **`ai.guardrail.injection(options?)`** — jailbreak / prompt-injection marker phrases. Extra `markers` (string | RegExp); `onMatch` defaults to `"flag"`, callers commonly use `"block"` on input.
- **`ai.guardrail.topic(options)`** — `deny` (string substring | RegExp) and/or `allow` (allow-list miss triggers `onMatch`). `onMatch` is `"block" | "flag"`, default `"block"`.
- **`ai.guardrail.pii(options?)`** — PII regex + dictionary (its own skill).

```ts
const policy = ai.guardrail({
  input: [
    ai.guardrail.injection({ onMatch: "block", markers: ["ignore previous instructions"] }),
    ai.guardrail.topic({ deny: ["competitor-name"], onMatch: "block" }),
  ],
});
```

## Scope tool detectors to specific tools

`tool` detectors fire on **every** tool call by default. Set `toolNames` to scope them — the whole middleware is wrapped with the core `forTool(toolNames, mw)` helper so the `tool` hooks fire only for those names; `input` / `output` (`trip`) hooks are unaffected:

```ts
const policy = ai.guardrail({
  tool: [ai.guardrail.pii({ onMatch: "block" })], // stop PII reaching the tool
  toolNames: ["send_email", "post_webhook"],      // ...only for these tools
});

const agent = ai.agent({ model, tools: [sendEmail, postWebhook, lookup], middleware: [policy] });
// `lookup` runs unguarded; `send_email` / `post_webhook` block on PII in their args.
```

A `block` from `tool.before` aborts that tool dispatch and surfaces on `result.error` with `phase: "tool"` — the agent run itself still never crashes.

## Install order

A guard is a normal `AgentMiddleware`; registration order is execution order (`before` top-down, `after` bottom-up). The canonical order is `[cache, budget, guardrail, observability]`. A `semanticCache` that short-circuits `trip.before` runs *before* the guard — a cached response then skips the **output** detectors, so place the guard before the cache if you don't trust cached contents.

## Input-redaction limitation (v1)

The core `trip.before` hook can only **short-circuit** (return a `ModelResponse`); it cannot rewrite the outbound prompt and continue. So:

- **Input detectors are `block` / `flag` only.** A `redact` verdict on an input detector is treated as a `block` rather than silently passing an un-redacted prompt.
- **Output redaction works** — `trip.after` returns a replacement `ModelResponse` with the rewritten `content`.
- **Tool-arg `redact` is also withheld** — it downgrades to a `block` (`reason: "tool-arg-redaction-unsupported"`), because silently rewriting tool arguments changes the call's side-effects unpredictably.

Lifting the input limitation needs a small, non-breaking core affordance and is deferred.

## Failure isolation

A detector's `check()` **rejecting** is an infrastructure fault, not a content violation — it is recorded as a `flag` (`<detector>.error`) into `ctx.state` and the fold **continues** (fail-open). A moderation-API outage degrades to missing annotation, never a failed agent run.

## See also

- [`@warlock.js/ai-guard/detect-and-redact-pii/SKILL.md`](@warlock.js/ai-guard/detect-and-redact-pii/SKILL.md) — the `pii` detector (detect/redact/block), the `mask` template, and the optional `moderation` peer.
- [`@warlock.js/ai-guard/escalate-block-to-human/SKILL.md`](@warlock.js/ai-guard/escalate-block-to-human/SKILL.md) — routing a `block` to a human-review surface via `escalation.onBlock`.
- [`@warlock.js/ai/run-ai-agent/SKILL.md`](@warlock.js/ai/run-ai-agent/SKILL.md) — running the agent, the middleware pipeline, and the `GuardrailViolationError` on `result.error`.
