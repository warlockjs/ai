import { describe, expect, it } from "vitest";
import type { EvaluateContext } from "../contracts/supervisor/evaluate-context.type";
import { buildQualityGate, buildVerifyGate } from "./gates";

/** Build a minimal `EvaluateContext` carrying just the state slice. */
function ctx<TState>(state: TState): EvaluateContext<TState> {
  return { state } as EvaluateContext<TState>;
}

describe("buildQualityGate", () => {
  it("terminates with satisfied when the gate key is truthy", () => {
    const gate = buildQualityGate<{ approved?: boolean }>();

    expect(gate(ctx({ approved: true }))).toEqual({ satisfied: true });
  });

  it("reassigns to the fixer with feedback when the gate key is falsy", () => {
    const gate = buildQualityGate<{ approved?: boolean; notes?: string }>();

    expect(gate(ctx({ approved: false, notes: "missing edge case" }))).toEqual({
      reassignTo: "fixer",
      feedback: "missing edge case",
    });
  });

  it("threads empty feedback when the feedback key is absent", () => {
    const gate = buildQualityGate<{ approved?: boolean }>();

    expect(gate(ctx({ approved: false }))).toEqual({
      reassignTo: "fixer",
      feedback: "",
    });
  });

  it("honors a custom gateKey, fixerRole, and feedbackKey", () => {
    const gate = buildQualityGate<Record<string, unknown>>(
      "ok",
      "repairman",
      "remarks",
    );

    expect(gate(ctx({ ok: false, remarks: "fix it" }))).toEqual({
      reassignTo: "repairman",
      feedback: "fix it",
    });
    expect(gate(ctx({ ok: true }))).toEqual({ satisfied: true });
  });
});

describe("buildVerifyGate", () => {
  it("terminates with satisfied when the gate key is truthy", () => {
    const gate = buildVerifyGate<{ passed?: boolean }>();

    expect(gate(ctx({ passed: true }))).toEqual({ satisfied: true });
  });

  it("reassigns to the fixer (no feedback) when the gate key is falsy", () => {
    const gate = buildVerifyGate<{ passed?: boolean }>();

    expect(gate(ctx({ passed: false }))).toEqual({ reassignTo: "fixer" });
  });

  it("honors a custom gateKey and fixerRole", () => {
    const gate = buildVerifyGate<Record<string, unknown>>("green", "patcher");

    expect(gate(ctx({ green: false }))).toEqual({ reassignTo: "patcher" });
    expect(gate(ctx({ green: true }))).toEqual({ satisfied: true });
  });
});
