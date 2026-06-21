---
name: pick-ai-provider
description: 'Choose an AI provider adapter — @warlock.js/ai-openai (shipped, also handles OpenRouter / Azure via baseURL), @warlock.js/ai-anthropic, @warlock.js/ai-bedrock, @warlock.js/ai-google, @warlock.js/ai-ollama — plus cost truth: ModelPricing (per-1M tokens), Usage cost breakdown, the cachedTokens / cacheWriteTokens / reasoningTokens channels, and capability flags. Triggers: `OpenAISDK`, `SDKAdapterContract`, `ModelContract`, `ModelPricing`, `ModelCapabilities`, `sdk.model`, `sdk.embedder`, `capabilities.vision`, `capabilities.structuredOutput`, `capabilities.reasoning`, `capabilities.promptCaching`, `pricing`, `Usage.cost`, `cachedTokens`, `cacheWriteTokens`, `reasoningTokens`, `reasoning.effort`, `cacheControl`, `baseURL`, `provider: "openrouter"`; ''pick a provider'', ''openai vs openrouter'', ''does this model support vision/reasoning'', ''configure pricing'', ''how much did reasoning cost'', ''prompt cache tokens''; typical import `import { OpenAISDK } from "@warlock.js/ai-openai"`. Skip: agent factory — `@warlock.js/ai/run-ai-agent/SKILL.md`; competing libs raw `openai`, `@anthropic-ai/sdk`, `@aws-sdk/client-bedrock-runtime`.'
---

# Pick an AI provider adapter

`@warlock.js/ai` is provider-agnostic. Concrete adapters live in sibling packages and follow the same `SDKAdapterContract`. Pick by which provider(s) your app talks to and which capabilities the model needs.

## Available adapters

| Package | Status | Notes |
| --- | --- | --- |
| `@warlock.js/ai-openai` | ✅ Shipped | OpenAI + any OpenAI-compatible gateway (OpenRouter, Together.ai, etc.) |
| `@warlock.js/ai-anthropic` | ✅ Shipped | Native Claude API (Opus / Sonnet / Haiku) |
| `@warlock.js/ai-bedrock` | ✅ Shipped | AWS Bedrock — Converse API + Titan embeddings |
| `@warlock.js/ai-google` | ✅ Shipped | Gemini direct via `@google/genai`, native batch embeddings |
| `@warlock.js/ai-ollama` | ✅ Shipped | Local models via the official `ollama` client |

All five first-party adapters share the same `SDKAdapterContract`, so switching providers is a one-line change at the model construction site. `ai-openrouter` is intentionally deferred — use `ai-openai` with a `baseURL` pointed at OpenRouter.

## Decision tree

- **Default first choice:** `@warlock.js/ai-openai` direct to OpenAI. Best support, predictable behavior, native structured-output, native vision on `gpt-4o*`, embeddings, streaming.
- **Need many models / cost arbitrage:** `@warlock.js/ai-openai` against OpenRouter. Same code, different `baseURL` + `provider: "openrouter"` on the SDK.
- **Need native Claude features:** `@warlock.js/ai-anthropic` — Opus / Sonnet / Haiku via the native Messages API.
- **Need local / self-hosted models:** `@warlock.js/ai-ollama`, or a local OpenAI-compatible gateway via `ai-openai`.
- **Need AWS Bedrock pricing / compliance:** `@warlock.js/ai-bedrock` — Converse API + Titan embeddings.
- **Need Gemini:** `@warlock.js/ai-google` — Gemini direct via `@google/genai`.

## The adapter contract

```ts
interface SDKAdapterContract {
  model(config): ModelContract;            // chat completions / tool calls / structured output
  count(text, model?): Promise<number>;    // token counting
  embedder?(config): EmbedderContract;     // optional — not every provider supports embeddings
}
```

Adapters are classes — `new OpenAISDK({ apiKey })`, `new AnthropicSDK({ apiKey })`. They expose:

- `model({ name, ...options })` — returns a `ModelContract`. The provider label lives on the returned `ModelContract.provider` (`"openai"`, `"openrouter"`, …), not on the SDK.
- `count(text, model?)` — provider-appropriate token count.
- `embedder({ name })` — text-to-vector. Optional; check `typeof sdk.embedder === "function"` before calling.

The `ModelContract.capabilities` field declares what the model supports — all flags optional (absent = treat as `false`):

```ts
type ModelCapabilities = {
  structuredOutput?: boolean;   // native response_format: json_schema support?
  vision?: boolean;             // can accept image attachments?
  reasoning?: boolean;          // forwards ModelCallOptions.reasoning (effort / thinking budget)?
  promptCaching?: boolean;      // honors cacheControl breakpoints + reports cache token channels?
  audio?: boolean;              // can accept audio ContentPart input?
  pdf?: boolean;                // can accept PDF / document ContentPart input?
};
```

The framework reads `capabilities` to fail loud upfront — e.g. passing `attachments: [...]` to a non-vision model throws at the boundary instead of failing mid-trip; reasoning / cacheControl options are silently skipped when the adapter doesn't declare support, rather than sent as unsupported params.

## OpenAI adapter — usage

```ts
import { OpenAISDK } from "@warlock.js/ai-openai";

// Direct OpenAI
const openai = new OpenAISDK({
  apiKey: process.env.OPENAI_API_KEY!,
  pricing: {
    "gpt-4o-mini": { input: 0.15, output: 0.6, cachedInput: 0.075 },
    "gpt-4o":      { input: 5.0,  output: 15.0 },
  },
});

const agent = ai.agent({ model: openai.model({ name: "gpt-4o-mini" }) });
```

### Via OpenRouter (cost arbitrage, many providers)

```ts
const openrouter = new OpenAISDK({
  apiKey: process.env.OPENROUTER_API_KEY!,
  baseURL: "https://openrouter.ai/api/v1",
  provider: "openrouter",   // labels reports correctly
});

const agent = ai.agent({ model: openrouter.model({ name: "anthropic/claude-3.5-sonnet" }) });
```

Same `OpenAISDK` class, different `baseURL`. Reports label the provider via the `provider` field for downstream metrics.

### Per-model overrides

```ts
const openai = new OpenAISDK({ apiKey });

// Override capabilities for a custom or fine-tuned model
const customModel = openai.model({
  name: "my-org/custom-gpt-4-finetuned",
  vision: true,                    // override capabilities.vision
  structuredOutput: true,
  pricing: { input: 1.0, output: 3.0 },   // per-model pricing (wins over SDK registry)
});
```

## Cost truth — pricing + token channels

`ModelPricing` is **USD per 1,000,000 tokens** (the industry-standard unit), declared at two optional sites — `SDK.pricing` (registry keyed by model name) and `model({ pricing })` (per-model override, wins). Resolution: per-model > SDK registry > undefined (no cost computed).

```ts
type ModelPricing = {
  input: number;            // required — USD / 1M input tokens
  output: number;           // required — USD / 1M output tokens
  cachedInput?: number;     // prompt-cache READ rate; falls back to `input`
  cachedOutput?: number;    // cache-WRITE rate (Anthropic premium); falls back to `output`
  reasoning?: number;       // reasoning/thinking-token rate; falls back to `output`
};
```

Configure it and every report carries `Usage.cost` — a per-channel breakdown captured at emit time as a historical fact (stored reports stay accurate after the upstream table changes):

```ts
const { usage } = await ai.agent({ model: openai.model({ name: "gpt-4o-mini" }) }).execute("hi");

usage.cost;          // { input, output, cachedInput?, cachedOutput? }  — USD per channel
// single scalar total: sum the populated fields, treating undefined as 0.
```

`usage.cost` is `undefined` when no pricing is available — honest absence over false zero. Aggregators merge only defined fields, so one unpriced child never erases a priced sibling's cost.

### Token channels (`Usage`) — what each adapter reports

Beyond `input` / `output` / `total`, `Usage` carries optional sub-channels (undefined when the provider doesn't meter them):

| Channel | Meaning | Provider source |
|---|---|---|
| `cachedTokens` | subset of `input` served from prompt cache (READ hit) | OpenAI `prompt_tokens_details.cached_tokens`, Anthropic `cache_read_input_tokens` |
| `cacheWriteTokens` | input tokens WRITTEN to the cache this call | Anthropic `cache_creation_input_tokens` (OpenAI does not write-bill) |
| `reasoningTokens` | subset of `output` for internal reasoning/thinking | OpenAI `completion_tokens_details.reasoning_tokens`, Anthropic extended-thinking |

### Driving cache + reasoning per call

`ModelCallOptions` exposes vendor-neutral controls the agent forwards only when `capabilities` allows:

```ts
await model.complete(messages, {
  reasoning: { effort: "high", maxTokens: 8_000 },  // effort → OpenAI reasoning_effort; maxTokens → Anthropic thinking budget
  cacheControl: { breakpoints: 1 },                 // WRITE breakpoint → Anthropic cache_control markers
});
```

Read-side cache accounting (`Usage.cachedTokens`) works WITHOUT `cacheControl` — it only controls WRITE placement. Adapters whose `capabilities.reasoning` / `.promptCaching` is absent ignore these rather than forwarding unsupported params.

## Embeddings

OpenAI ships the first embedder:

```ts
const embedder = openai.embedder({ name: "text-embedding-3-small" });
const { vector } = await embedder.embed("Hello, world.");
```

See [`@warlock.js/ai/embed-text/SKILL.md`](@warlock.js/ai/embed-text/SKILL.md).

## Multi-provider apps

Pattern: one SDK instance per provider, mix at the call site:

```ts
const openai     = new OpenAISDK({ apiKey: process.env.OPENAI_API_KEY! });
const openrouter = new OpenAISDK({
  apiKey: process.env.OPENROUTER_API_KEY!,
  baseURL: "https://openrouter.ai/api/v1",
  provider: "openrouter",
});

const fastAgent  = ai.agent({ model: openai.model({ name: "gpt-4o-mini" }) });
const claudeAgent = ai.agent({ model: openrouter.model({ name: "anthropic/claude-3.5-sonnet" }) });
```

Reports label per-agent provider correctly. Pricing applies per SDK instance.

## When the adapter changes

If you switch providers mid-project (e.g. OpenAI → Anthropic):

1. The agent factory call signature stays the same — `ai.agent({ model: <newSdk>.model({...}) })`.
2. Capabilities matter — if the new model doesn't support `structuredOutput` natively, fall back to the soft "respond in JSON only" instruction (framework handles it).
3. Errors stay typed — `ProviderAuthError`, `ContextLengthExceededError`, etc. are adapter-agnostic.
4. Pricing matrix needs updating per the new provider's rates.

## See also

- [`@warlock.js/ai-openai/setup-openai/SKILL.md`](@warlock.js/ai-openai/setup-openai/SKILL.md) — full OpenAI adapter docs
- [`@warlock.js/ai/run-ai-agent/SKILL.md`](@warlock.js/ai/run-ai-agent/SKILL.md) — model passed into `ai.agent({...})`
- [`@warlock.js/ai/embed-text/SKILL.md`](@warlock.js/ai/embed-text/SKILL.md) — embedder primitive on the SDK
- [`@warlock.js/ai/handle-ai-errors/SKILL.md`](@warlock.js/ai/handle-ai-errors/SKILL.md) — adapter error categorization
