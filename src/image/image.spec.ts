import { describe, expect, it } from "vitest";
import type { GeneratedImage } from "../contracts/image-model.contract";
import { ProviderError, ProviderRateLimitError } from "../errors";
import type { Observer } from "../observe/observer.contract";
import { MockImageModel } from "../mock/mock-image-model";
import { image } from "./image";

describe("ai.image", () => {
  it("returns the generated images on success", async () => {
    const model = new MockImageModel("mock-image", [{}]);

    const result = await image({ model, prompt: "a red bicycle" });

    expect(result.type).toBe("image");
    expect(result.error).toBeUndefined();
    expect(result.report.status).toBe("completed");
    expect(result.data?.images).toHaveLength(1);
    expect(result.data?.images[0]).toMatchObject({ type: "base64", mediaType: "image/png" });
  });

  it("returns one image per requested count", async () => {
    const model = new MockImageModel("mock-image", [{}]);

    const result = await image({ model, prompt: "tiles", count: 3 });

    expect(result.data?.images).toHaveLength(3);
    expect(result.report.imageCount).toBe(3);
  });

  it("never throws — surfaces a typed AIError on result.error", async () => {
    const rateLimit = new ProviderRateLimitError("slow down");
    const model = new MockImageModel("mock-image", [{ error: rateLimit }]);

    const result = await image({ model, prompt: "x" });

    expect(result.error).toBe(rateLimit);
    expect(result.data).toBeUndefined();
    expect(result.report.status).toBe("failed");
    expect(result.report.error).toBe(rateLimit);
    expect(result.report.imageCount).toBe(0);
  });

  it("wraps a non-AIError thrown value in ProviderError", async () => {
    const model = new MockImageModel("mock-image", [{ error: new Error("boom") }]);

    const result = await image({ model, prompt: "x" });

    expect(result.error).toBeInstanceOf(ProviderError);
    expect(result.error?.message).toBe("boom");
    expect((result.error as unknown as { cause?: unknown }).cause).toBeInstanceOf(Error);
  });

  it("prices per-image spend into usage.cost", async () => {
    const model = new MockImageModel("mock-image", [{}], { perImage: 0.04 });

    const result = await image({ model, prompt: "x", count: 2 });

    expect(result.usage.cost?.input).toBe(0);
    expect(result.usage.cost?.output).toBeCloseTo(0.08, 10);
  });

  it("resolves per-size pricing tiers, falling back to the flat rate", async () => {
    const model = new MockImageModel("mock-image", [{}], {
      perImage: 0.04,
      perImageBySize: { "1792x1024": 0.08 },
    });

    const tiered = await image({ model, prompt: "x", size: "1792x1024" });
    expect(tiered.usage.cost?.output).toBeCloseTo(0.08, 10);

    const flat = await image({ model, prompt: "x", size: "1024x1024" });
    expect(flat.usage.cost?.output).toBeCloseTo(0.04, 10);
  });

  it("prices token-metered image models via the standard cost math", async () => {
    const model = new MockImageModel(
      "gpt-image-1",
      [{ usage: { input: 1000, output: 2000, total: 3000 } }],
      { input: 5, output: 40 },
    );

    const result = await image({ model, prompt: "x" });

    expect(result.usage.total).toBe(3000);
    expect(result.usage.cost?.input).toBeCloseTo(0.005, 10);
    expect(result.usage.cost?.output).toBeCloseTo(0.08, 10);
  });

  it("leaves usage.cost undefined when the model is unpriced", async () => {
    const model = new MockImageModel("mock-image", [{}]);

    const result = await image({ model, prompt: "x" });

    expect(result.usage.cost).toBeUndefined();
  });

  it("forwards generation options to the model", async () => {
    const model = new MockImageModel("mock-image", [{}]);

    await image({
      model,
      prompt: "x",
      count: 2,
      size: "1024x1024",
      quality: "hd",
      aspectRatio: "16:9",
      negativePrompt: "blurry",
      format: "webp",
      options: { background: "transparent" },
    });

    expect(model.calls[0].prompt).toBe("x");
    expect(model.calls[0].options).toMatchObject({
      count: 2,
      size: "1024x1024",
      quality: "hd",
      aspectRatio: "16:9",
      negativePrompt: "blurry",
      format: "webp",
      background: "transparent",
    });
  });

  it("marks the run cancelled when the caller's signal aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = new MockImageModel("mock-image", [{ error: new Error("aborted") }]);

    const result = await image({ model, prompt: "x", signal: controller.signal });

    expect(result.report.status).toBe("cancelled");
    expect(result.error).toBeInstanceOf(ProviderError);
  });

  it("routes the completed report to a flow-local observer", async () => {
    const seen: { type: string; status: string }[] = [];
    const collector: Observer = {
      collect(report) {
        seen.push({ type: report.type, status: report.status });
      },
    };
    const model = new MockImageModel("mock-image", [{}]);

    await image({ model, prompt: "x", observe: collector });

    expect(seen).toEqual([{ type: "image", status: "completed" }]);
  });

  it("builds a coherent report — lineage, schema version, model identity", async () => {
    const model = new MockImageModel("imagen-4.0-generate-001", [{}]);

    const { report } = await image({ model, prompt: "x", sessionId: "sess-1" });

    expect(report.runId.startsWith("image_")).toBe(true);
    expect(report.rootRunId).toBe(report.runId);
    expect(report.parentRunId).toBeUndefined();
    expect(report.type).toBe("image");
    expect(report.model).toEqual({ name: "imagen-4.0-generate-001", provider: "mock" });
    expect(report.children).toEqual([]);
    expect(report.sessionId).toBe("sess-1");
    expect(report.reportSchemaVersion).toBeDefined();
    expect(typeof report.duration).toBe("number");
  });

  it("passes a custom data image straight through, normalized", async () => {
    const custom: GeneratedImage = { type: "url", url: "https://x/y.png", revisedPrompt: "rp" };
    const model = new MockImageModel("mock-image", [{ images: [custom] }]);

    const result = await image({ model, prompt: "x" });

    expect(result.data?.images[0]).toEqual(custom);
  });

  it("preserves prompt-cache tokens and prices the discounted input", async () => {
    const model = new MockImageModel(
      "gpt-image-1",
      [{ usage: { input: 1000, output: 0, total: 1000, cachedTokens: 500 } }],
      { input: 5, output: 40 },
    );

    const result = await image({ model, prompt: "x" });

    expect(result.usage.cachedTokens).toBe(500);
    // 500 uncached @ $5/1M = 0.0025; 500 cached @ fallback $5/1M = 0.0025.
    expect(result.usage.cost?.input).toBeCloseTo(0.0025, 10);
    expect(result.usage.cost?.cachedInput).toBeCloseTo(0.0025, 10);
  });

  it("preserves adapter-reported usage channels (reasoning)", async () => {
    const model = new MockImageModel("mock-image", [
      { usage: { input: 0, output: 0, total: 0, reasoningTokens: 7 } },
    ]);

    const result = await image({ model, prompt: "x" });

    expect(result.usage.reasoningTokens).toBe(7);
  });

  it("honors an adapter-supplied cost instead of recomputing it", async () => {
    const model = new MockImageModel(
      "mock-image",
      [{ usage: { input: 0, output: 0, total: 0, cost: { input: 1, output: 2 } } }],
      // Per-image pricing is present, but the response already carries a
      // cost — the facade must NOT overwrite it.
      { perImage: 0.04 },
    );

    const result = await image({ model, prompt: "x" });

    expect(result.usage.cost).toEqual({ input: 1, output: 2 });
  });
});
