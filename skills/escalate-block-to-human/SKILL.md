---
name: escalate-block-to-human
description: 'Route a hard guardrail block to a human-review surface with @warlock.js/ai-guard — the `escalation.onBlock` seam and an `escalate: true` verdict. Triggers: `escalation`, `onBlock`, `GuardrailEscalation`, `GuardrailBlockEvent`, `escalate: true`, `{ type: "block", escalate: true }`, ''escalate a block to a human'', ''human review queue for guardrail'', ''page an operator on a guardrail block'', ''human-in-the-loop guardrail'', ''compose a block with a review surface'', ''custom detector that escalates''; typical import `import "@warlock.js/ai-guard"` then `ai.guardrail({ escalation: { onBlock } })`. Skip: composing the guard / phases / verdict model — `@warlock.js/ai-guard/guard-input-output/SKILL.md`; PII/moderation detectors — `@warlock.js/ai-guard/detect-and-redact-pii/SKILL.md`; durable suspend/resume human-step machinery (deferred) — not in this package.'
---

# Escalate a block to a human

A `block` verdict can carry `escalate: true`. When it does, the guard `await`s your `escalation.onBlock(...)` handler **before** throwing the `GuardrailViolationError` — the seam to a human-review queue, an operator page, or any out-of-band approval surface.

```ts
import { ai } from "@warlock.js/ai";
import "@warlock.js/ai-guard";

const policy = ai.guardrail({
  output: [ai.guardrail.moderation({ blockOn: ["self-harm"] })],
  escalation: {
    async onBlock(event) {
      await reviewQueue.enqueue({
        phase: event.phase,   // "input" | "output" | "tool"
        reason: event.reason, // the detector's human-readable reason
      });
    },
  },
});

const agent = ai.agent({ model, middleware: [policy] });
```

## When `onBlock` fires

`onBlock` fires **only** for a verdict of `{ type: "block", escalate: true }` — not for an ordinary `block`, and never for `allow` / `redact` / `flag`. It is **awaited before** the `GuardrailViolationError` is thrown, so your handler runs to completion (enqueue succeeds, the page is sent) before the error surfaces on `result.error`. The run still aborts: escalation is a *signal*, not a recovery — `execute()` returns with `result.error` populated as usual.

## The `GuardrailBlockEvent` payload

`onBlock(event)` receives:

| Field | Type | Meaning |
|---|---|---|
| `phase` | `"input" \| "output" \| "tool"` | where the block fired |
| `reason` | `string` | the detector's human-readable reason |
| `matches` | `readonly GuardrailMatch[] \| undefined` | what tripped the rule (rule id, span, label), when reported |
| `ctx` | `MiddlewareTripContext` | the live trip context — `state`, `messages`, `agent`, `model`, `signal` |

`ctx` lets the handler enrich the review item with run context (session id from `ctx.state`, the offending messages, etc.).

## Producing an escalating verdict

The built-in detectors return ordinary `block` verdicts (no `escalate`). To escalate, author a tiny custom `GuardrailDetector` that sets `escalate: true` on its `block`:

```ts
import type { GuardrailDetector } from "@warlock.js/ai-guard";

const wirePolicy: GuardrailDetector = {
  name: "wire-transfer",
  check(text) {
    if (/wire \$?\d{5,}/i.test(text)) {
      return {
        type: "block",
        reason: "large wire transfer requires human approval",
        escalate: true, // <- routes through escalation.onBlock
        matches: [{ rule: "wire-transfer.large", label: "wire" }],
      };
    }

    return { type: "allow" };
  },
};

const policy = ai.guardrail({
  tool: [wirePolicy],
  toolNames: ["initiate_transfer"],
  escalation: { async onBlock(e) { await approvals.request(e); } },
});
```

A `check()` may be sync or async (async = call an external service); the guard awaits either.

## A plain callback by design

`escalation.onBlock` is a **plain callback** — `ai-guard` takes **no** dependency on the deferred durable human-step machinery (suspend/resume). The callback is the decoupling seam: inside it you wire your own review queue, and (where your stack supports it) a `workflow.resume(...)` loop. This package only emits the *signal*; it does not own durable suspension. When the typed human-step handoff ships, `onBlock` upgrades to it without a breaking change here.

## See also

- [`@warlock.js/ai-guard/guard-input-output/SKILL.md`](@warlock.js/ai-guard/guard-input-output/SKILL.md) — composing the guard, the phases, the verdict model, and how a `block` surfaces on `result.error`.
- [`@warlock.js/ai-guard/detect-and-redact-pii/SKILL.md`](@warlock.js/ai-guard/detect-and-redact-pii/SKILL.md) — the `pii` detector and the optional `moderation` peer that commonly drives an escalation.
