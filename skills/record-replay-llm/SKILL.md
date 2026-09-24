---
name: record-replay-llm
description: 'Deterministic, offline LLM tests with ai.vcr(model,{path,mode}) — a record/replay decorator over ANY ModelContract that intercepts only complete()/stream(), delegates name/provider/capabilities/pricing to the inner model, and hashes each request against a JSON cassette on disk. Covers the three modes (record / replay / auto), the cassette format, save(), VcrCassetteMissError, streaming round-trip, hashOptions, and composing below fallbackModel. Triggers: `ai.vcr`, `vcr`, `VcrModel`, `VcrOptions`, `VcrMode`, `Cassette`, `CassetteEntry`, `VcrCassetteMissError`, `hashRequest`, `DEFAULT_HASH_OPTIONS`, `mode`, `path`, `hashOptions`, `save`, `cassette`, record, replay, cassette; ''record LLM responses for tests'', ''replay model calls offline in CI'', ''deterministic agent test without hitting the provider'', ''cassette for model calls''; typical import `import { ai } from "@warlock.js/ai"`. Skip: eval scoring + regression gating — `@warlock.js/ai/eval-datasets-and-ci/SKILL.md`; the Vitest matchers + mockRouter — `@warlock.js/ai/ai-dx-helpers/SKILL.md`; choosing a provider adapter — `@warlock.js/ai/pick-ai-provider/SKILL.md`; competing libs `nock`, `polly.js`.'
---

# `ai.vcr()` — record / replay any model

`ai.vcr(model, { path, mode })` wraps any `ModelContract` in a record/replay decorator backed by a JSON cassette on disk. It intercepts only `complete()` / `stream()` — the single seam every agent trip funnels through — and delegates `name`, `provider`, `capabilities`, and `pricing` to the inner model untouched, so cost accounting and capability detection are unchanged. Depends only on `ModelContract`, so it works with **any** adapter.

## Shape

```ts
import { ai } from "@warlock.js/ai";
import { OpenAISDK } from "@warlock.js/ai-openai";

const openai = new OpenAISDK({ apiKey: process.env.OPENAI_API_KEY! });
const live = openai.model({ name: "gpt-4o-mini" });

const model = ai.vcr(live, {
  path: "./cassettes/support.json",  // cassette file (JSON); read on construct, written on save()
  mode: "auto",                      // "record" | "replay" | "auto" (default)
});

const agent = ai.agent({ model, systemPrompt: "..." });
const result = await agent.execute("hi");

await model.save(); // first run records; later runs replay deterministically
```

The returned `VcrModel` is a `ModelContract` plus `save(): Promise<void>` and a readonly `cassette` (exposed for assertions).

## Modes — `VcrMode`

- **`record`** — always calls the inner model and appends a cassette entry. Never replays (the in-memory cassette starts empty, so a record run never accidentally replays a stale entry). Use to (re)capture a fresh cassette.
- **`replay`** — never calls the inner model. A cassette hit returns the stored response / re-yields its chunks / re-throws its error; a **miss throws `VcrCassetteMissError`** — never a silent live call. Use in CI for deterministic, offline tests.
- **`auto`** (default) — replay on a hit, record on a miss. The friendliest mode for local dev: records once, replays thereafter.

## Request hashing — `hashOptions`

On each call VCR computes a stable hash over `{ messages, picked options }` and looks for a matching `CassetteEntry`. The hashed option fields default to:

```ts
["temperature", "maxTokens", "responseSchema", "tools", "reasoning"]
```

(`DEFAULT_HASH_OPTIONS`). `signal` and unknown provider keys are **always excluded**, so an otherwise-identical logical call still matches. `tools` are hashed by name + description + input-schema shape, not object identity. Override `hashOptions` to widen / narrow what counts as "the same request". `hashRequest(messages, options, hashOptions)` is exported for direct use.

## Cassette format

A `Cassette` is `{ version: 1, model, provider, entries: CassetteEntry[] }`. Each `CassetteEntry` is `{ requestHash, request: { messages, options? }, ... }` where **exactly one** of `response` / `chunks` / `error` is populated — mirroring the three outcomes of a model call (non-streaming reply, streamed chunk list, or a thrown provider error). The full `request` is stored verbatim for human readability and so the cassette can be re-hashed if the hashing format ever changes.

## Streaming round-trip

```ts
for await (const chunk of model.stream(messages)) {
  // record mode: buffers each chunk into entry.chunks[] while re-emitting
  // replay mode: re-yields the stored chunks in order (delta / tool-call / done sequence)
}
await model.save();
```

Recorded chunks reproduce the exact `delta` / `tool-call` / `done` sequence on replay; a recorded error is re-thrown.

## `VcrCassetteMissError`

```ts
import { VcrCassetteMissError } from "@warlock.js/ai";

try {
  await vcrModel.complete(messages);
} catch (error) {
  if (error instanceof VcrCassetteMissError) {
    console.error("Re-record the cassette:", error.path, error.requestHash);
  }
}
```

Thrown only in `replay` mode on a miss (code `"VCR_CASSETTE_MISS"`). It carries the looked-up `requestHash` and the cassette `path` so a failing CI run names exactly which call was not recorded. Extends `AIError` directly (not `ProviderError`) — a miss is a harness/config failure, not a provider failure. **The whole point:** `replay` never falls back to a live call, which would silently re-introduce non-determinism into a test that asked for the opposite. Re-record by running once in `record` / `auto`.

## `save()` — flush new entries

`save()` writes newly recorded entries to `path`. It is a **no-op when nothing was recorded** (pure replay, or a record/auto run that only hit cached entries), so calling it unconditionally is safe.

## Composition

VCR composes **below** `ai.fallbackModel` and works with any adapter. Wrap the live model in `vcr(...)`, then pass it anywhere a `ModelContract` is accepted (agent, planner, reranker, judge).

## See also

- [`@warlock.js/ai/eval-datasets-and-ci/SKILL.md`](@warlock.js/ai/eval-datasets-and-ci/SKILL.md) — pair a cassette with a dataset for fully offline eval CI
- [`@warlock.js/ai/ai-dx-helpers/SKILL.md`](@warlock.js/ai/ai-dx-helpers/SKILL.md) — `ai.mockRouter` + Vitest matchers for the rest of the test surface
- [`@warlock.js/ai/pick-ai-provider/SKILL.md`](@warlock.js/ai/pick-ai-provider/SKILL.md) — the adapters whose models VCR wraps
