import { describe, expect, it, vi } from "vitest";
import type { GuardrailDetectorContext } from "../contracts";
import { moderation } from "./moderation";

// Records the constructor options the detector passed when it built the
// client from the lazily-imported SDK.
const constructed: { apiKey?: string }[] = [];

const create = vi.fn().mockResolvedValue({
  results: [
    {
      flagged: true,
      categories: { violence: true },
      category_scores: { violence: 0.99 },
    },
  ],
});

// Stub the OPTIONAL `openai` peer so the detector's lazy `import("openai")`
// resolves to a fake SDK whose default export is the client constructor —
// the OpenAI Node SDK v4 shape (`new OpenAI({ apiKey }).moderations.create`).
vi.mock("openai", () => {
  class FakeOpenAI {
    public readonly moderations = { create };

    public constructor(options: { apiKey?: string }) {
      constructed.push(options);
    }
  }

  return { default: FakeOpenAI };
});

const CTX = {
  phase: "output",
  ctx: {},
} as unknown as GuardrailDetectorContext;

describe("moderation (lazy openai import)", () => {
  it("should construct the client from the lazily-imported SDK and moderate", async () => {
    const verdict = await moderation({ apiKey: "sk-test", blockOn: ["violence"] }).check(
      "bad text",
      CTX,
    );

    // The detector built a client from the mocked SDK, passing the apiKey...
    expect(constructed).toContainEqual({ apiKey: "sk-test" });
    // ...called moderations.create...
    expect(create).toHaveBeenCalledWith({
      model: "omni-moderation-latest",
      input: "bad text",
    });
    // ...and mapped the flagged+blockOn category to a block verdict.
    expect(verdict.type).toBe("block");
  });
});
