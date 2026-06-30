---
name: detect-and-redact-pii
description: 'Detect and redact PII (and run model-graded moderation) with @warlock.js/ai-guard detectors — `ai.guardrail.pii(...)` and the optional `ai.guardrail.moderation(...)` peer. Triggers: `ai.guardrail.pii`, `piiDetector`, `PiiDetectorOptions`, `PiiCategory`, `mask`, `{label}`, `dictionary`, `onMatch`, `ai.guardrail.moderation`, `openAiModeration`, `OpenAiModerationOptions`, `blockOn`, `omni-moderation-latest`; ''redact PII from model output'', ''mask SSN / credit card / email / phone / IP'', ''stop PII leaking into a tool call'', ''scrub sensitive data'', ''add OpenAI moderation'', ''block violent / self-harm content''; typical import `import "@warlock.js/ai-guard"` (registers `ai.guardrail.pii` / `.moderation`) or `import { pii, moderation } from "@warlock.js/ai-guard"`. Skip: composing the guard / wiring it into an agent — `@warlock.js/ai-guard/guard-input-output/SKILL.md`; routing a block to a human — `@warlock.js/ai-guard/escalate-block-to-human/SKILL.md`.'
---

# Detect and redact PII (and moderate)

`ai.guardrail.pii(...)` is a **zero-dependency** detector — regex + exact-string matching, no runtime peer. Pass it into any phase array of `ai.guardrail({ ... })`.

```ts
import { ai } from "@warlock.js/ai";
import "@warlock.js/ai-guard";

const policy = ai.guardrail({
  output: [ai.guardrail.pii({ onMatch: "redact", mask: "[REDACTED:{label}]" })],
});
```

## Categories — `detect`

Scans for these `PiiCategory` values; `detect` narrows the set (default: all). Each pattern is **linear** (anchored, no nested quantifiers) — safe against catastrophic backtracking.

| Category | Matches |
|---|---|
| `ssn` | US Social Security numbers |
| `email` | email addresses |
| `phone` | phone numbers |
| `credit-card` | credit-card numbers |
| `ipv4` | IPv4 addresses |

```ts
ai.guardrail.pii({ detect: ["ssn", "credit-card"] }); // scan only these two
```

Add `dictionary` for extra exact-string terms (internal codenames, customer IDs) treated as PII alongside the built-in regexes:

```ts
ai.guardrail.pii({ dictionary: ["PROJECT-ORION", "ACME-INTERNAL"] });
```

## Action — `onMatch`

`onMatch` is `"redact" | "block" | "flag"`, default **`"redact"`**:

- **`redact`** — replace each match with the `mask` and continue (output phase only — see below).
- **`block`** — reject the trip / tool call with a `GuardrailViolationError`.
- **`flag`** — allow but record the matches into `ctx.state` for a downstream observer.

## The `mask` template

On `redact`, each match is replaced by `mask`. The `{label}` token is substituted with the matched category, so a redacted SSN becomes `[REDACTED:ssn]`:

```ts
ai.guardrail.pii({ onMatch: "redact", mask: "[REDACTED:{label}]" });
// "My SSN is 123-45-6789" -> "My SSN is [REDACTED:ssn]"
```

Omit `mask` to use the default fixed placeholder.

## Where redaction actually applies

Redaction only rewrites-and-continues where the pipeline seam supports it:

- **Output (`output: [...]`)** — works. `trip.after` returns a replacement `ModelResponse` with the scrubbed `content`. This is the primary PII-redaction use case.
- **Input (`input: [...]`)** — a `redact` verdict **downgrades to `block`**. The core `trip.before` hook can only short-circuit, not rewrite-and-continue, so the un-redacted prompt can't be threaded back.
- **Tool (`tool: [...]`)** — a `redact` verdict **downgrades to `block`** (`reason: "tool-arg-redaction-unsupported"`), because silently rewriting tool arguments changes the call's side-effects.

So: **redact on output, block on input/tool.**

```ts
const policy = ai.guardrail({
  output: [ai.guardrail.pii({ onMatch: "redact", mask: "[REDACTED:{label}]" })], // scrub the answer
  tool: [ai.guardrail.pii({ onMatch: "block" })],                                // refuse to leak into tools
  toolNames: ["send_email"],
});
```

## Optional moderation peer — `ai.guardrail.moderation`

For model-graded content (violence, self-harm, hate) beyond regex, the optional `moderation` detector calls OpenAI's moderation endpoint. The `openai` SDK is an **optional lazy peer** — importing `@warlock.js/ai-guard` never forces it to resolve; the detector throws a curated install string on first `check()` when the peer is absent (mirrors ai-panoptic's lazy Langfuse exporter).

```ts
const policy = ai.guardrail({
  output: [
    ai.guardrail.moderation({ blockOn: ["violence", "self-harm"] }),
  ],
});
```

- `blockOn` — categories that escalate to `block`; every other flagged category produces a `flag`. Omit to `flag` on any category.
- `model` — defaults to `"omni-moderation-latest"`.
- `apiKey` — defaults to `OPENAI_API_KEY`.
- `client` — pass a pre-built OpenAI-compatible client to bypass the lazy import entirely (the bring-your-own-client / test escape hatch).

Install the peer only when you use this detector:

```bash
npm install openai
```

## See also

- [`@warlock.js/ai-guard/guard-input-output/SKILL.md`](@warlock.js/ai-guard/guard-input-output/SKILL.md) — composing the guard, the verdict model, phases, and `toolNames` scoping.
- [`@warlock.js/ai-guard/escalate-block-to-human/SKILL.md`](@warlock.js/ai-guard/escalate-block-to-human/SKILL.md) — escalating a hard `block` to a human-review surface.
