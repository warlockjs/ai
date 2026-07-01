---
name: transcribe-audio
description: 'Speech-to-text via ai.transcribe({ model: sdk.transcribe({ name }), audio }) — the audio-INPUT verb (Theme I), returning the uniform never-throws { data, error, usage, report } envelope with cost-truth + panoptic observation. Feed it an AudioInput = { base64; mediaType; filename? } — build one with ai.audioFromFile(path) (reads disk, infers media type incl. WhatsApp .ogg/.opus) or ai.audioFromBuffer(bytes, mediaType). Models: OpenAI whisper-1 (verbose_json, per-minute, segments + durationSeconds) or gpt-4o-transcribe (json, per-token). Triggers: `ai.transcribe`, `ai.audioFromFile`, `ai.audioFromBuffer`, `sdk.transcribe`, `openai.transcribe`, `TranscriptionModelContract`, `AudioInput`, `TranscriptionSegment`, `MockTranscriptionModel`; ''speech to text'', ''transcribe audio'', ''voice note to text'', ''WhatsApp voice message'', ''whisper'', ''gpt-4o-transcribe'', ''subtitle segments'', ''audio input''; typical import `import { ai } from "@warlock.js/ai"` + `import { OpenAISDK } from "@warlock.js/ai-openai"`. Skip: text-to-speech / synthesizing a voice — [[generate-speech]]; competing libs raw `openai.audio.transcriptions.create`, `whisper.cpp`.'
---

# Transcribe audio — the speech-to-text verb (`ai.transcribe`)

`ai.transcribe()` is the inverse of `ai.speech()` on the modality track (Theme I). Audio-in / text-out, wrapped in the same uniform result contract every executable returns — so transcribing a support voicemail slots into cost dashboards and panoptic traces exactly like an agent run.

**Extracting text from an audio file NEEDS AI** — that is the `ai.transcribe` step. The file handling (`ai.audioFromFile` / `ai.audioFromBuffer`) is pure, non-AI **utility** that just packages bytes into an `AudioInput`; it does no I/O to a provider on its own.

This is audio **input** (STT). For audio **output** (synthesizing a voice line), see [[generate-speech]].

## Shape — WhatsApp voice note → text, end to end

```ts
import { ai } from "@warlock.js/ai";
import { OpenAISDK } from "@warlock.js/ai-openai";

const openai = new OpenAISDK({ apiKey: process.env.OPENAI_API_KEY! });

// audioFromFile reads the file + infers the media type from the extension.
// .ogg / .opus (Android WhatsApp) and .m4a (iOS) are recognized out of the box.
const audio = await ai.audioFromFile("./voice-note.ogg");

const { data, error } = await ai.transcribe({
  model: openai.transcribe({ name: "whisper-1" }),
  audio,
  language: "en", // BCP-47 hint — improves accuracy + latency
});

if (error) console.warn(error.code); // typed AIError
else console.log(data.text);         // the transcript
```

`TranscriptionModelContract` mirrors `SpeechModelContract` — a peer primitive produced by the adapter's optional `transcribe?()` factory. A non-STT model id (`openai.transcribe({ name: "gpt-4o" })`) throws `InvalidRequestError` **at construction** — fail fast, like the speech/embedder guards.

## The `AudioInput` shape + the two builders

```ts
type AudioInput = {
  base64: string;    // base64-encoded audio bytes
  mediaType: string; // IANA type, e.g. "audio/ogg", "audio/mpeg"
  filename?: string; // helps providers infer the codec from the extension
};

// From a file on disk — reads + infers media type (override for extensionless files).
const fromDisk = await ai.audioFromFile("./meeting.m4a");
const forced   = await ai.audioFromFile("./blob", { mediaType: "audio/ogg" });

// From bytes you already hold (an upload buffer, a downloaded blob) — no I/O, no AI.
const fromBytes = ai.audioFromBuffer(uploadBuffer, "audio/ogg", "note.ogg");
```

Keeping `AudioInput` as inlined base64 + explicit media type makes the verb provider-neutral and serializable — there is no `fs` coupling in core, so the same request can cross a queue or an RPC boundary.

## The result envelope

```ts
type TranscriptionResult = {
  type: "transcription";
  data?: {
    text: string;                    // full transcript
    segments?: TranscriptionSegment[]; // timestamped, in verbose mode
  };                                 // undefined on failure
  error?: AIError;                   // undefined on success — NEVER thrown
  usage: Usage;                      // tokens (gpt-4o-transcribe) + cost when priced
  report: TranscriptionReport;       // type:"transcription", model, durationSeconds, lineage
};

type TranscriptionSegment = { text: string; start?: number; end?: number };
```

`segments` and `report.durationSeconds` appear only when the provider returns them (whisper's `verbose_json` mode). Use segments to build subtitles or to jump-to-timestamp in a player.

## Transcribe options (provider-neutral)

```ts
await ai.transcribe({
  model,
  audio,
  language: "en",              // BCP-47 hint
  prompt: "Names: Acme, Zoë",  // priming — spelling / style hints
  format: "verbose_json",      // response-format override (segments + duration)
  signal,                      // AbortSignal
  observe: collector,          // route the report to an Observer (panoptic)
  sessionId: "ticket-88",      // group into a session for flat cost/trace queries
  options: { /* provider passthrough */ },
});
```

## OpenAI — whisper-1 (per-minute) + gpt-4o-transcribe (per-token)

```ts
// whisper-1 — defaults to verbose_json → segments + duration; billed PER MINUTE.
const whisper = openai.transcribe({ name: "whisper-1", pricing: { perMinute: 0.006 } });

// gpt-4o-transcribe — defaults to json; billed PER TOKEN like a chat model.
const gpt = openai.transcribe({ name: "gpt-4o-transcribe", pricing: { input: 2.5, output: 10 } });

const { data, usage } = await ai.transcribe({ model: whisper, audio });
// data.segments → [{ text, start, end }, …]; usage.cost from report.durationSeconds
```

The adapter wraps the base64 bytes in an uploadable via the SDK's `toFile`, using `audio.filename` (or `"audio"`) and `audio.mediaType` so the codec is declared correctly.

## Cost-truth — one rollup, two metering models

`ai.transcribe` fills `usage.cost` so STT spend folds into the **same** `Usage.cost` rollup as text:

- **Per-minute** (`whisper-1`): `{ perMinute }` × `(durationSeconds / 60)` → `cost.input`. If the provider didn't report a duration, cost stays **`undefined`** (no guessing).
- **Token-metered** (`gpt-4o-transcribe`): `{ input, output }` USD-per-1M-tokens → standard `computeCost` against the returned token usage.

Per-minute wins when both are set; an unpriced model leaves `usage.cost` **`undefined`** (honest "cost unknown", never a false zero).

## Pattern — inbound voice-message webhook

```ts
const stt = openai.transcribe({ name: "whisper-1" });

async function onVoiceMessage(buffer: Buffer, mediaType: string) {
  const audio = ai.audioFromBuffer(buffer, mediaType, "inbound.ogg");
  const { data, error } = await ai.transcribe({ model: stt, audio, sessionId: "inbox" });

  if (error) return replyWith("Sorry, I couldn't understand that audio.");
  return routeToAgent(data.text); // hand the transcript to an ai.agent for a reply
}
```

## Observability

The completed `TranscriptionReport` (with `report.durationSeconds` and cost/latency attributed to `report.model`) routes to any registered `Observer` (panoptic, OTel, …) through the shared `observe` seam — `observe: true` (global), an `Observer` (flow-local), or observe-all. See [[observe-ai-flows]]. Provider faults surface as typed `AIError`s on `result.error`; see [[handle-ai-errors]].

## Testing

`MockTranscriptionModel(name, responses, pricing?)` is a deterministic `TranscriptionModelContract` double — no HTTP. Script text/segments/duration/usage/errors and inspect `model.calls`. `MockSDK({ transcriptionResponses, transcriptionPricing }).transcribe({ name })` wires the same double behind a full adapter.

```ts
import { MockTranscriptionModel, transcribe } from "@warlock.js/ai";

const AUDIO = { base64: "QUJD", mediaType: "audio/mpeg", filename: "clip.mp3" };

const model = new MockTranscriptionModel("whisper-1", [{ durationSeconds: 120 }], { perMinute: 0.006 });
const { data, usage, report } = await transcribe({ model, audio: AUDIO });
// data.text → "mock transcript"
// usage.cost.input → (120 / 60) * 0.006   report.durationSeconds → 120
// model.calls[0] records { audio, options } for assertions
```

Scripting `[{ error: new ProviderRateLimitError("slow down") }]` drives the never-throws path — `result.error` is the typed error and `result.data` is `undefined`.

## See also

- [[generate-speech]] — the inverse verb (`ai.speech`), text → audio
- [[generate-images]] — the sibling image-output verb (`ai.image`)
- [[observe-ai-flows]] — routing the `TranscriptionReport` to panoptic / OTel
- [[handle-ai-errors]] — the typed `AIError` taxonomy on `result.error`
