---
name: generate-images
description: 'Text-to-image via ai.image({ model: sdk.image({ name }), prompt }) — the image-OUTPUT verb (Theme I), returning the uniform never-throws { data, error, usage, report } envelope with cost-truth + panoptic observation. Models come from an adapter''s image() factory: OpenAI gpt-image-* (token-metered) / dall-e-* (per-image), Google imagen-* (per-image). Result images are a discriminated GeneratedImage = { type: "base64" } | { type: "url" }. Triggers: `ai.image`, `sdk.image`, `openai.image`, `google.image`, `ImageModelContract`, `GeneratedImage`, `ImageModelPricing`; ''generate an image'', ''text to image'', ''gpt-image'', ''dall-e'', ''imagen'', ''product thumbnail'', ''image output''; typical import `import { ai } from "@warlock.js/ai"` + `import { OpenAISDK } from "@warlock.js/ai-openai"`. Skip: image INPUT / vision attachments to a chat agent — `@warlock.js/ai/run-ai-agent/SKILL.md`; embeddings — `@warlock.js/ai/embed-text/SKILL.md`; competing libs raw `openai.images.generate`, `langchain` image tools.'
---

# Generate images — the image-output verb (`ai.image`)

`ai.image()` is the output counterpart to `ai.agent` for the image modality (the first verb of the output-modality track, Theme I). Prompt-in / images-out, wrapped in the same uniform result contract every executable returns — so it slots into cost dashboards and panoptic traces exactly like an agent run.

This is image **output** (generation). For image/PDF/audio **input** to a chat agent (vision), see [`@warlock.js/ai/run-ai-agent/SKILL.md`](@warlock.js/ai/run-ai-agent/SKILL.md).

## Shape

```ts
// 1. Build an image model from an adapter's image() factory.
const model = openai.image({ name: "gpt-image-1" });   // ImageModelContract

// 2. Run the verb — never throws; failures land on result.error.
const { data, error, usage, report } = await ai.image({ model, prompt: "a red bicycle" });

if (error) {
  console.warn(error.code);          // typed AIError (auth / rate-limit / content-filter / …)
} else {
  for (const img of data.images) {   // GeneratedImage[]
    if (img.type === "base64") save(Buffer.from(img.base64, "base64"), img.mediaType);
    else download(img.url);
  }
}
```

`ImageModelContract` mirrors `EmbedderContract` — a peer primitive on the SDK adapter, produced by the optional `image?()` factory. An adapter without an image API simply doesn't define `image()`, so `ai.anthropic.image(...)` is a **compile-time** error, not a silent runtime failure.

## The result envelope

```ts
type ImageResult = {
  type: "image";
  data?: { images: GeneratedImage[] };  // undefined on failure
  error?: AIError;                       // undefined on success — NEVER thrown
  usage: Usage;                          // tokens (gpt-image) + cost when priced
  report: ImageReport;                   // type:"image", model, imageCount, lineage
};

type GeneratedImage =
  | { type: "base64"; base64: string; mediaType: string; revisedPrompt?: string }
  | { type: "url"; url: string; mediaType?: string; revisedPrompt?: string };
```

## Generation options (provider-neutral)

```ts
await ai.image({
  model,
  prompt: "an isometric office desk, soft studio lighting",
  count: 2,            // n images
  size: "1024x1024",   // OpenAI WxH (also resolves perImageBySize pricing)
  quality: "high",     // OpenAI quality tier
  aspectRatio: "16:9", // Imagen ratio
  negativePrompt: "blurry, watermark", // Imagen
  format: "png",       // output container hint
  signal,              // AbortSignal
  observe: collector,  // route the report to an Observer (panoptic), like agents
  sessionId: "checkout-123",
  options: { background: "transparent" }, // provider-specific passthrough
});
```

Each adapter maps the options its API supports and ignores the rest. `options` is the escape hatch for provider-specific knobs (OpenAI `background`, DALL·E `responseFormat: "url"`, Imagen `imageSize` / `personGeneration`).

## OpenAI — gpt-image (token-metered) + DALL·E (per-image)

```ts
import { OpenAISDK } from "@warlock.js/ai-openai";

const openai = new OpenAISDK({ apiKey: process.env.OPENAI_API_KEY! });

// gpt-image-1 always returns base64 bytes; priced per TOKEN.
const gpt = openai.image({ name: "gpt-image-1", pricing: { input: 5, output: 40 } });

// DALL·E 3 — per-image pricing; defaults to base64 (opt into url with options).
const dalle = openai.image({ name: "dall-e-3", pricing: { perImage: 0.04 } });
```

A non-image model id (`openai.image({ name: "gpt-4o" })`) throws `InvalidRequestError` **at construction** — fail fast, like the embedder/vision guards.

## Google — Imagen (per-image)

```ts
import { GoogleSDK } from "@warlock.js/ai-google";

const google = new GoogleSDK({ apiKey: process.env.GEMINI_API_KEY! });
const imagen = google.image({ name: "imagen-4.0-generate-001", pricing: { perImage: 0.04 } });

const { data } = await ai.image({ model: imagen, prompt: "a watercolor lighthouse at dawn", aspectRatio: "3:4" });
```

Imagen returns base64 bytes (no hosted URL). When every candidate is safety-filtered, `ai.image` surfaces a typed `ContentFilterError` on `result.error`.

## Cost-truth — one rollup, two metering models

`ai.image` fills `usage.cost` (a `ModelPricing`-shaped USD breakdown) so image spend folds into the **same** `Usage.cost` rollup as text — no second accounting path:

- **Token-metered** (gpt-image-1): `{ input, output }` USD-per-1M-tokens → standard `computeCost` against the returned token usage.
- **Per-image** (DALL·E, Imagen): `{ perImage }` (or `perImageBySize["1792x1024"]`) × image count → `cost.output`.

Unpriced model → `usage.cost` stays `undefined` (honest "cost unknown", never a false zero). A pre-priced adapter response is honored, not overwritten.

## Pattern — catalog thumbnail in a workflow `run` step

```ts
ai.step({
  name: "thumbnail",
  run: async (ctx) => {
    const { data, error } = await ai.image({
      model: openai.image({ name: "gpt-image-1" }),
      prompt: `product photo, white background: ${ctx.steps.extract.output.title}`,
      size: "1024x1024",
    });
    if (error) throw error; // step retry/backoff handles transient provider faults
    ctx.state.thumb = data.images[0];
  },
});
```

## Observability

The completed `ImageReport` routes to any registered `Observer` (panoptic, OTel, …) through the shared `observe` seam — pass `observe: true` (global), an `Observer` object (flow-local), or rely on observe-all. Cost + latency attribute to `report.model` for free. See [`@warlock.js/ai/observe-ai-flows/SKILL.md`](@warlock.js/ai/observe-ai-flows/SKILL.md).

## Testing

`MockSDK({ imageResponses, imagePricing }).image({ name })` returns a deterministic `MockImageModel` — no HTTP. Script images/usage/errors and inspect `model.calls`.

```ts
import { MockSDK } from "@warlock.js/ai";

const mock = MockSDK({ imageResponses: [{}], imagePricing: { perImage: 0.04 } });
const { data, usage } = await ai.image({ model: mock.image({ name: "mock-image" }), prompt: "x" });
```
