import { describe, expect, it } from "vitest";
import { agent } from "../../agent/agent";
import { GuardrailViolationError } from "../../errors";
import { MockSDK } from "../../mock/mock-sdk";
import { guardrail } from "./guardrail";

function makeAgent(
  content: string,
  middleware: ReturnType<typeof guardrail>[],
) {
  const sdk = MockSDK({ responses: [{ content, finishReason: "stop" }] });
  return agent({ model: sdk.model({ name: "gpt-test" }), middleware });
}

describe("guardrail — inputCheck", () => {
  it("passes when inputCheck returns ok", async () => {
    const ai = makeAgent("reply", [
      guardrail({ inputCheck: async () => ({ ok: true }) }),
    ]);

    const result = await ai.execute("safe prompt");

    expect(result.error).toBeUndefined();
    expect(result.text).toBe("reply");
  });

  it("aborts trip 0 with phase=input when inputCheck rejects", async () => {
    const ai = makeAgent("never-runs", [
      guardrail({
        inputCheck: async text =>
          text.includes("SSN") ? { ok: false, reason: "pii" } : { ok: true },
      }),
    ]);

    const result = await ai.execute("my SSN is 123");

    expect(result.error).toBeInstanceOf(GuardrailViolationError);
    const gv = result.error as GuardrailViolationError;
    expect(gv.phase).toBe("input");
    expect(gv.reason).toBe("pii");
    expect(result.report.trips).toHaveLength(1);
    expect(result.report.trips[0].finishReason).toBe("error");
  });
});

describe("guardrail — outputCheck", () => {
  it("passes when outputCheck returns ok", async () => {
    const ai = makeAgent("all good", [
      guardrail({ outputCheck: async () => ({ ok: true }) }),
    ]);

    const result = await ai.execute("hi");

    expect(result.error).toBeUndefined();
  });

  it("aborts with phase=output when the response fails the check", async () => {
    const ai = makeAgent("forbidden content", [
      guardrail({
        outputCheck: async text =>
          text.includes("forbidden")
            ? { ok: false, reason: "policy" }
            : { ok: true },
      }),
    ]);

    const result = await ai.execute("hi");

    expect(result.error).toBeInstanceOf(GuardrailViolationError);
    const gv = result.error as GuardrailViolationError;
    expect(gv.phase).toBe("output");
    expect(gv.reason).toBe("policy");
  });

  it("exposes the configured guardrail name on the error", async () => {
    const ai = makeAgent("bad", [
      guardrail({
        name: "pii-guard",
        outputCheck: async () => ({
          ok: false,
          reason: "classifier-triggered",
        }),
      }),
    ]);

    const result = await ai.execute("hi");

    const gv = result.error as GuardrailViolationError;
    expect(gv.guardrail).toBe("pii-guard");
  });
});
