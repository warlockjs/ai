---
name: generate-speech
description: 'Text-to-speech via ai.speech({ model: sdk.speech({ name }), text }) — the audio-OUTPUT verb (Theme I), returning the uniform never-throws { data, error, usage, report } envelope with cost-truth + panoptic observation. Models come from an adapter''s speech() factory: OpenAI tts-1 / tts-1-hd (per-character) or gpt-4o-mini-tts (per-token). Synthesized audio is a discriminated GeneratedAudio = { type: "base64"; base64; mediaType }. Options: voice / format / speed / instructions / signal. Triggers: `ai.speech`, `sdk.speech`, `openai.speech`, `SpeechModelContract`, `GeneratedAudio`, `SpeechModelPricing`, `SpeechOptions`, `MockSpeechModel`; ''text to speech'', ''TTS'', ''synthesize voice'', ''read this aloud'', ''tts-1'', ''gpt-4o-mini-tts'', ''voice narration'', ''audio output'', ''speak this text''; typical import `import { ai } from "@warlock.js/ai"` + `import { OpenAISDK } from "@warlock.js/ai-openai"`. Skip: speech-to-text / transcribing a voice note — [[transcribe-audio]]; image OUTPUT — [[generate-images]]; competing libs raw `openai.audio.speech.create`, `elevenlabs` SDK.'
---

# Generate speech — the text-to-speech verb (`ai.speech`)

`ai.speech()` is the audio-output counterpart to `ai.image()` on the output-modality track (Theme I). Text-in / audio-out, wrapped in the same uniform result contract every executable returns — so a synthesized voicemail slots into cost dashboards and panoptic traces exactly like an agent run.

This is audio **output** (TTS). For audio **input** (speech-to-text on a WhatsApp voice note or a meeting recording), see [[transcribe-audio]].

## Shape

```ts
// 1. Build a speech model from an adapter's speech() factory.
const model = openai.speech({ name: "tts-1", voice: "alloy" }); // SpeechModelContract

// 2. Run the verb — never throws; failures land on result.error.
const { data, error, usage, report } = await ai.speech({ model, text: "Your order has shipped." });

if (error) {
  console.warn(error.code);          // typed AIError (auth / rate-limit / content-filter / …)
} else {
  const { base64, mediaType } = data.audio; // GeneratedAudio (always base64 today)
  await fs.writeFile("ship.mp3", Buffer.from(base64, "base64"));
}
```

`SpeechModelContract` mirrors `EmbedderContract` / `ImageModelContract` — a peer primitive produced by the adapter's optional `speech?()` factory. An adapter without a TTS API simply doesn't define `speech()`, so calling it is a **compile-time** error, not a silent runtime failure. A non-TTS model id (`openai.speech({ name: "gpt-4o" })`) throws `InvalidRequestError` **at construction** — fail fast, like the embedder/image guards.

## The result envelope

```ts
type SpeechResult = {
  type: "speech";
  data?: { audio: GeneratedAudio }; // undefined on failure
  error?: AIError;                  // undefined on success — NEVER thrown
  usage: Usage;                     // tokens (gpt-4o-mini-tts) + cost when priced
  report: SpeechReport;             // type:"speech", model, characters, lineage
};

type GeneratedAudio = {
  type: "base64";
  base64: string;    // base64-encoded audio bytes
  mediaType: string; // IANA type, e.g. "audio/mpeg", "audio/wav"
};
```

`GeneratedAudio` is a discriminated union with a single `base64` variant today — the union leaves room for a future hosted-`url` variant without a breaking change, so always branch on `audio.type` rather than assuming `base64`.

## Generation options (provider-neutral)

```ts
await ai.speech({
  model,
  text: "Welcome aboard. Let's get you set up.",
  voice: "verse",                 // voice id/name; overrides the model's default
  format: "wav",                  // "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm"
  speed: 1.25,                    // playback multiplier (OpenAI 0.25–4.0)
  instructions: "calm, warm",     // tone/delivery steering (gpt-4o-mini-tts only)
  signal,                         // AbortSignal
  observe: collector,             // route the report to an Observer (panoptic), like agents
  sessionId: "onboarding-42",     // group into a session for flat cost/trace queries
  options: { /* provider passthrough */ },
});
```

Each adapter maps the options its API supports and forwards `options` verbatim. On OpenAI the container defaults to `mp3` (→ `audio/mpeg`); `speed` and `instructions` are only sent when set, and the default voice is `alloy` when neither the call nor the model config supplies one.

## OpenAI — tts-1 (per-character) + gpt-4o-mini-tts (per-token)

```ts
import { ai } from "@warlock.js/ai";
import { OpenAISDK } from "@warlock.js/ai-openai";

const openai = new OpenAISDK({ apiKey: process.env.OPENAI_API_KEY! });

// tts-1 / tts-1-hd — billed per INPUT CHARACTER.
const classic = openai.speech({ name: "tts-1", voice: "alloy", pricing: { perMillionCharacters: 15 } });

// gpt-4o-mini-tts — billed per TOKEN like a chat model; supports `instructions`.
const steered = openai.speech({ name: "gpt-4o-mini-tts", pricing: { input: 0.6, output: 12 } });

const { data } = await ai.speech({ model: steered, text: "Read this warmly.", instructions: "gentle" });
```

## Cost-truth — one rollup, two metering models

`ai.speech` fills `usage.cost` (a USD breakdown) so TTS spend folds into the **same** `Usage.cost` rollup as text — no second accounting path:

- **Per-character** (`tts-1` / `tts-1-hd`): `{ perMillionCharacters }` × `report.characters` → `cost.input`. The Speech API reports no token usage, so `usage` tokens stay `{ 0, 0, 0 }` and spend is priced entirely from the input character count.
- **Token-metered** (`gpt-4o-mini-tts`): `{ input, output }` USD-per-1M-tokens → standard `computeCost` against the returned token usage.

Per-character wins when both are set. An unpriced model leaves `usage.cost` **`undefined`** (honest "cost unknown", never a false zero); a pre-priced adapter response is honored, not overwritten.

## Pattern — order-confirmation voice line in a workflow `run` step

```ts
ai.step({
  name: "voiceLine",
  run: async (ctx) => {
    const { data, error } = await ai.speech({
      model: openai.speech({ name: "tts-1", voice: "alloy" }),
      text: `Order ${ctx.steps.order.output.id} confirmed. Thank you!`,
      format: "mp3",
    });
    if (error) throw error; // step retry/backoff handles transient provider faults
    ctx.state.audio = data.audio; // { type:"base64", base64, mediaType:"audio/mpeg" }
  },
});
```

## Observability

The completed `SpeechReport` (with `report.characters` and cost/latency attributed to `report.model`) routes to any registered `Observer` (panoptic, OTel, …) through the shared `observe` seam — pass `observe: true` (global), an `Observer` object (flow-local), or rely on observe-all. See [[observe-ai-flows]]. Provider faults surface as typed `AIError`s on `result.error`; see [[handle-ai-errors]].

## Testing

`MockSpeechModel(name, responses, pricing?)` is a deterministic `SpeechModelContract` double — no HTTP. Script audio/usage/errors and inspect `model.calls`. `MockSDK({ speechResponses, speechPricing }).speech({ name })` wires the same double behind a full adapter.

```ts
import { MockSpeechModel } from "@warlock.js/ai";
import { speech } from "@warlock.js/ai";

const model = new MockSpeechModel("tts-1", [{}], { perMillionCharacters: 15 });
const { data, usage } = await speech({ model, text: "abcdefghij" }); // 10 chars
// data.audio → { type:"base64", base64:"AAAA", mediaType:"audio/mpeg" }
// usage.cost.input → (10 * 15) / 1_000_000
// model.calls[0] records { text, options } for assertions
```

Scripting `[{ error: new ProviderRateLimitError("slow down") }]` drives the never-throws path — `result.error` is the typed error and `result.data` is `undefined`.

## See also

- [[transcribe-audio]] — the inverse verb (`ai.transcribe`), audio → text
- [[generate-images]] — the sibling image-output verb (`ai.image`)
- [[observe-ai-flows]] — routing the `SpeechReport` to panoptic / OTel
- [[handle-ai-errors]] — the typed `AIError` taxonomy on `result.error`
