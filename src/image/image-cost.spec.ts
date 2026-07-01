import { describe, expect, it } from "vitest";
import type { Usage } from "../contracts/result/usage.type";
import { computeImageCost } from "./image-cost";

const zeroUsage: Usage = { input: 0, output: 0, total: 0 };

describe("computeImageCost", () => {
  it("returns undefined when no pricing is configured", () => {
    expect(computeImageCost(zeroUsage, 1, undefined, undefined)).toBeUndefined();
  });

  it("prices flat per-image", () => {
    expect(computeImageCost(zeroUsage, 3, undefined, { perImage: 0.02 })).toEqual({
      input: 0,
      output: 0.06,
    });
  });

  it("prefers a matching per-size tier over the flat rate", () => {
    const cost = computeImageCost(zeroUsage, 1, "1792x1024", {
      perImage: 0.04,
      perImageBySize: { "1792x1024": 0.08 },
    });
    expect(cost).toEqual({ input: 0, output: 0.08 });
  });

  it("falls back to the flat rate when the size has no tier", () => {
    const cost = computeImageCost(zeroUsage, 2, "256x256", {
      perImage: 0.04,
      perImageBySize: { "1792x1024": 0.08 },
    });
    expect(cost).toEqual({ input: 0, output: 0.08 });
  });

  it("returns undefined when per-image metering has no resolvable rate", () => {
    // perImageBySize configured (so it IS per-image metered) but neither the
    // requested size nor a flat perImage resolves a number.
    const cost = computeImageCost(zeroUsage, 1, "256x256", {
      perImageBySize: { "1024x1024": 0.04 },
    });
    expect(cost).toBeUndefined();
  });

  it("prices token-metered models with the standard cost math", () => {
    const usage: Usage = { input: 1000, output: 2000, total: 3000 };
    const cost = computeImageCost(usage, 1, undefined, { input: 5, output: 40 });
    expect(cost?.input).toBeCloseTo(0.005, 10);
    expect(cost?.output).toBeCloseTo(0.08, 10);
  });

  it("ignores token rates once per-image metering is configured", () => {
    // A provider is one OR the other; per-image wins so a stray input/output
    // never double-counts.
    const cost = computeImageCost(zeroUsage, 1, undefined, {
      input: 5,
      output: 40,
      perImage: 0.04,
    });
    expect(cost).toEqual({ input: 0, output: 0.04 });
  });
});
