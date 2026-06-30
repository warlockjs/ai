import { describe, expect, it, vi } from "vitest";
import type {
  GuardrailDetectorContext,
  OpenAiClientLike,
  OpenAiModerationResponse,
  OpenAiModerationResult,
} from "../contracts";
import { moderation } from "./moderation";

const CTX = {
  phase: "output",
  ctx: {},
} as unknown as GuardrailDetectorContext;

/**
 * Build a stub {@link OpenAiClientLike} that returns a single canned
 * moderation result — the bring-your-own-client escape hatch lets the spec
 * exercise the verdict mapping without the `openai` SDK on disk.
 */
function makeClient(result: OpenAiModerationResult | undefined) {
  const create = vi
    .fn<(body: { model: string; input: string }) => Promise<OpenAiModerationResponse>>()
    .mockResolvedValue({ results: result ? [result] : [] });

  const client: OpenAiClientLike = { moderations: { create } };

  return { client, create };
}

const cleanResult: OpenAiModerationResult = {
  flagged: false,
  categories: { violence: false, hate: false },
  category_scores: { violence: 0.01, hate: 0.02 },
};

const violentResult: OpenAiModerationResult = {
  flagged: true,
  categories: { violence: true, hate: false },
  category_scores: { violence: 0.97, hate: 0.02 },
};

describe("moderation", () => {
  it("should advertise the moderation.openai name", () => {
    const { client } = makeClient(cleanResult);

    expect(moderation({ client }).name).toBe("moderation.openai");
  });

  it("should allow a clean (not flagged) result", async () => {
    const { client, create } = makeClient(cleanResult);

    const verdict = await moderation({ client }).check("a friendly hello", CTX);

    expect(verdict).toEqual({ type: "allow" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("should allow when the response carries no results", async () => {
    const { client } = makeClient(undefined);

    const verdict = await moderation({ client }).check("anything", CTX);

    expect(verdict).toEqual({ type: "allow" });
  });

  it("should flag a flagged category that is not in blockOn", async () => {
    const { client } = makeClient(violentResult);

    const verdict = await moderation({ client }).check("bad text", CTX);

    expect(verdict.type).toBe("flag");

    if (verdict.type !== "flag") {
      throw new Error("expected a flag verdict");
    }

    expect(verdict.matches).toEqual([{ rule: "moderation.violence", label: "violence" }]);
    expect(verdict.reason).toContain("violence");
  });

  it("should block a flagged category listed in blockOn", async () => {
    const { client } = makeClient(violentResult);

    const verdict = await moderation({ client, blockOn: ["violence"] }).check(
      "bad text",
      CTX,
    );

    expect(verdict.type).toBe("block");

    if (verdict.type !== "block") {
      throw new Error("expected a block verdict");
    }

    expect(verdict.matches).toEqual([{ rule: "moderation.violence", label: "violence" }]);
    expect(verdict.reason).toContain("violence");
  });

  it("should flag (not block) when the flagged category is outside blockOn", async () => {
    const { client } = makeClient(violentResult);

    const verdict = await moderation({ client, blockOn: ["hate"] }).check(
      "bad text",
      CTX,
    );

    expect(verdict.type).toBe("flag");
  });

  it("should send the configured model and input to the client", async () => {
    const { client, create } = makeClient(cleanResult);

    await moderation({ client, model: "text-moderation-stable" }).check(
      "inspect me",
      CTX,
    );

    expect(create).toHaveBeenCalledWith({
      model: "text-moderation-stable",
      input: "inspect me",
    });
  });

  it("should default to the omni-moderation-latest model", async () => {
    const { client, create } = makeClient(cleanResult);

    await moderation({ client }).check("inspect me", CTX);

    expect(create).toHaveBeenCalledWith({
      model: "omni-moderation-latest",
      input: "inspect me",
    });
  });
});
