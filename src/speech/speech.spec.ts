import { describe, expect, it } from "vitest";
import { ProviderError, ProviderRateLimitError } from "../errors";
import { MockSpeechModel } from "../mock/mock-speech-model";
import type { Observer } from "../observe/observer.contract";
import { speech } from "./speech";

describe("ai.speech", () => {
  it("returns the synthesized audio on success", async () => {
    const model = new MockSpeechModel("tts-1", [{}]);
    const result = await speech({ model, text: "hello" });

    expect(result.type).toBe("speech");
    expect(result.error).toBeUndefined();
    expect(result.report.status).toBe("completed");
    expect(result.data?.audio).toMatchObject({ type: "base64", mediaType: "audio/mpeg" });
    expect(result.report.characters).toBe(5);
  });

  it("never throws — surfaces a typed AIError on result.error", async () => {
    const rate = new ProviderRateLimitError("slow down");
    const model = new MockSpeechModel("tts-1", [{ error: rate }]);
    const result = await speech({ model, text: "x" });

    expect(result.error).toBe(rate);
    expect(result.data).toBeUndefined();
    expect(result.report.status).toBe("failed");
  });

  it("wraps a non-AIError in ProviderError", async () => {
    const model = new MockSpeechModel("tts-1", [{ error: new Error("boom") }]);
    const result = await speech({ model, text: "x" });
    expect(result.error).toBeInstanceOf(ProviderError);
  });

  it("prices per-character TTS into usage.cost", async () => {
    const model = new MockSpeechModel("tts-1", [{}], { perMillionCharacters: 15 });
    const result = await speech({ model, text: "abcdefghij" }); // 10 chars
    expect(result.usage.cost?.input).toBeCloseTo((10 * 15) / 1_000_000, 12);
  });

  it("prices token-metered TTS via the standard cost math", async () => {
    const model = new MockSpeechModel(
      "gpt-4o-mini-tts",
      [{ usage: { input: 1000, output: 2000, total: 3000 } }],
      { input: 0.6, output: 12 },
    );
    const result = await speech({ model, text: "x" });
    expect(result.usage.cost?.input).toBeCloseTo(0.0006, 12);
    expect(result.usage.cost?.output).toBeCloseTo(0.024, 12);
  });

  it("leaves usage.cost undefined when unpriced", async () => {
    const model = new MockSpeechModel("tts-1", [{}]);
    const result = await speech({ model, text: "x" });
    expect(result.usage.cost).toBeUndefined();
  });

  it("forwards options to the model", async () => {
    const model = new MockSpeechModel("tts-1", [{}]);
    await speech({ model, text: "x", voice: "verse", format: "wav", speed: 1.25, instructions: "calm" });
    expect(model.calls[0].options).toMatchObject({
      voice: "verse",
      format: "wav",
      speed: 1.25,
      instructions: "calm",
    });
  });

  it("marks the run cancelled when the signal aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = new MockSpeechModel("tts-1", [{ error: new Error("aborted") }]);
    const result = await speech({ model, text: "x", signal: controller.signal });
    expect(result.report.status).toBe("cancelled");
  });

  it("routes the report to a flow-local observer", async () => {
    const seen: string[] = [];
    const collector: Observer = { collect: (r) => void seen.push(`${r.type}:${r.status}`) };
    const model = new MockSpeechModel("tts-1", [{}]);
    await speech({ model, text: "x", observe: collector });
    expect(seen).toEqual(["speech:completed"]);
  });

  it("builds a coherent report", async () => {
    const model = new MockSpeechModel("tts-1", [{}]);
    const { report } = await speech({ model, text: "x", sessionId: "s1" });
    expect(report.runId.startsWith("speech_")).toBe(true);
    expect(report.rootRunId).toBe(report.runId);
    expect(report.type).toBe("speech");
    expect(report.model).toEqual({ name: "tts-1", provider: "mock" });
    expect(report.sessionId).toBe("s1");
  });
});
