import { describe, expect, it, vi } from "vitest";
import type { GuardrailDetectorContext } from "../contracts";
import { moderation } from "./moderation";

// Simulate `openai` NOT being installed: the dynamic import rejects, so the
// loader's flag flips to false and the detector must throw the curated
// install string on first check() — never a raw module-resolution error.
// `vi.mock` is hoisted above the imports, so the stub applies to `moderation`'s
// lazy `import("openai")` even though it is statically imported here.
vi.mock("openai", () => {
  throw new Error("Cannot find module 'openai'");
});

const CTX = {
  phase: "output",
  ctx: {},
} as unknown as GuardrailDetectorContext;

describe("moderation (missing openai peer)", () => {
  it("should throw curated install instructions when openai is absent", async () => {
    const detector = moderation();

    await expect(detector.check("inspect me", CTX)).rejects.toThrow(
      /requires the optional "openai" peer/,
    );
  });
});
