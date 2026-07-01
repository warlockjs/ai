import { describe, expect, it } from "vitest";
import type { AudioInput } from "../contracts/transcription-model.contract";
import { ProviderError, ProviderRateLimitError } from "../errors";
import { MockTranscriptionModel } from "../mock/mock-transcription-model";
import type { Observer } from "../observe/observer.contract";
import { transcribe } from "./transcribe";

const AUDIO: AudioInput = { base64: "QUJD", mediaType: "audio/mpeg", filename: "clip.mp3" };

describe("ai.transcribe", () => {
  it("returns the transcript on success", async () => {
    const model = new MockTranscriptionModel("whisper-1", [
      { text: "hello world", segments: [{ text: "hello world", start: 0, end: 1 }] },
    ]);
    const result = await transcribe({ model, audio: AUDIO });

    expect(result.type).toBe("transcription");
    expect(result.error).toBeUndefined();
    expect(result.data?.text).toBe("hello world");
    expect(result.data?.segments).toHaveLength(1);
  });

  it("never throws — surfaces a typed AIError on result.error", async () => {
    const rate = new ProviderRateLimitError("slow down");
    const model = new MockTranscriptionModel("whisper-1", [{ error: rate }]);
    const result = await transcribe({ model, audio: AUDIO });
    expect(result.error).toBe(rate);
    expect(result.data).toBeUndefined();
    expect(result.report.status).toBe("failed");
  });

  it("wraps a non-AIError in ProviderError", async () => {
    const model = new MockTranscriptionModel("whisper-1", [{ error: new Error("boom") }]);
    const result = await transcribe({ model, audio: AUDIO });
    expect(result.error).toBeInstanceOf(ProviderError);
  });

  it("prices per-minute STT into usage.cost", async () => {
    const model = new MockTranscriptionModel("whisper-1", [{ durationSeconds: 120 }], {
      perMinute: 0.006,
    });
    const result = await transcribe({ model, audio: AUDIO });
    expect(result.usage.cost?.input).toBeCloseTo((120 / 60) * 0.006, 12); // 0.012
    expect(result.report.durationSeconds).toBe(120);
  });

  it("leaves cost undefined for per-minute pricing when no duration is reported", async () => {
    const model = new MockTranscriptionModel("whisper-1", [{}], { perMinute: 0.006 });
    const result = await transcribe({ model, audio: AUDIO });
    expect(result.usage.cost).toBeUndefined();
  });

  it("prices token-metered STT via the standard cost math", async () => {
    const model = new MockTranscriptionModel(
      "gpt-4o-transcribe",
      [{ usage: { input: 1000, output: 500, total: 1500 } }],
      { input: 2.5, output: 10 },
    );
    const result = await transcribe({ model, audio: AUDIO });
    expect(result.usage.cost?.input).toBeCloseTo(0.0025, 12);
    expect(result.usage.cost?.output).toBeCloseTo(0.005, 12);
  });

  it("forwards options + the audio to the model", async () => {
    const model = new MockTranscriptionModel("whisper-1", [{}]);
    await transcribe({ model, audio: AUDIO, language: "en", prompt: "names: Acme", format: "verbose_json" });
    expect(model.calls[0].audio).toEqual(AUDIO);
    expect(model.calls[0].options).toMatchObject({
      language: "en",
      prompt: "names: Acme",
      format: "verbose_json",
    });
  });

  it("marks the run cancelled when the signal aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = new MockTranscriptionModel("whisper-1", [{ error: new Error("aborted") }]);
    const result = await transcribe({ model, audio: AUDIO, signal: controller.signal });
    expect(result.report.status).toBe("cancelled");
  });

  it("routes the report to a flow-local observer", async () => {
    const seen: string[] = [];
    const collector: Observer = { collect: (r) => void seen.push(`${r.type}:${r.status}`) };
    const model = new MockTranscriptionModel("whisper-1", [{}]);
    await transcribe({ model, audio: AUDIO, observe: collector });
    expect(seen).toEqual(["transcription:completed"]);
  });
});
