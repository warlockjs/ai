import { describe, expect, it } from "vitest";
import { generateRunId } from "./generate-run-id";

describe("generateRunId", () => {
  it("starts with the supplied prefix followed by an underscore", () => {
    expect(generateRunId("tool").startsWith("tool_")).toBe(true);
    expect(generateRunId("agent").startsWith("agent_")).toBe(true);
  });

  it("produces three underscore-separated segments: prefix, timestamp, random", () => {
    const id = generateRunId("wf");
    const [prefix, timestamp, random] = id.split("_");

    expect(prefix).toBe("wf");
    // Both trailing segments are non-empty base36 strings.
    expect(timestamp).toMatch(/^[0-9a-z]+$/);
    expect(random).toMatch(/^[0-9a-z]+$/);
  });

  it("encodes the timestamp segment as base36 of a recent Date.now()", () => {
    const before = Date.now();
    const id = generateRunId("sup");
    const after = Date.now();

    const timestamp = id.split("_")[1];
    const decoded = parseInt(timestamp, 36);

    expect(decoded).toBeGreaterThanOrEqual(before);
    expect(decoded).toBeLessThanOrEqual(after);
  });

  it("keeps the random segment at most 8 characters", () => {
    // Source slices Math.random().toString(36) at [2, 10) → ≤ 8 chars.
    for (let i = 0; i < 50; i++) {
      const random = generateRunId("x").split("_")[2];
      expect(random.length).toBeGreaterThanOrEqual(1);
      expect(random.length).toBeLessThanOrEqual(8);
    }
  });

  it("generates collision-resistant ids within a tight loop", () => {
    const ids = new Set<string>();

    for (let i = 0; i < 1000; i++) {
      ids.add(generateRunId("tool"));
    }

    // The random suffix makes same-millisecond collisions vanishingly
    // unlikely — 1000 ids should all be distinct in practice.
    expect(ids.size).toBe(1000);
  });

  it("accepts an arbitrary prefix verbatim (never parsed)", () => {
    expect(generateRunId("custom-prefix").startsWith("custom-prefix_")).toBe(
      true,
    );
    expect(generateRunId("").startsWith("_")).toBe(true);
  });
});
