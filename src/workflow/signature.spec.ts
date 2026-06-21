import { describe, expect, it } from "vitest";
import type { StepDefinition } from "../contracts/workflow/step.contract";
import type { WorkflowDefinition } from "../contracts/workflow/workflow.contract";
import { computeSignature } from "./signature";

/**
 * Build a minimal `WorkflowDefinition` for signature tests. Only the
 * fields the fingerprint reads (`name`, `version`, `steps`) matter —
 * everything else is irrelevant to `computeSignature` and omitted.
 */
function def(
  partial: Partial<WorkflowDefinition> & { name: string },
): WorkflowDefinition {
  return {
    steps: [],
    ...partial,
  };
}

/** A `run` step — the simplest non-empty step type. */
function runStep(name: string): StepDefinition {
  return { name, run: () => undefined };
}

describe("computeSignature (workflow)", () => {
  it("produces an 8-char lowercase hex string", () => {
    const sig = computeSignature(def({ name: "wf", steps: [runStep("a")] }));

    expect(sig).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic — identical definitions hash identically", () => {
    const a = computeSignature(
      def({ name: "wf", steps: [runStep("a"), runStep("b")] }),
    );
    const b = computeSignature(
      def({ name: "wf", steps: [runStep("a"), runStep("b")] }),
    );

    expect(a).toBe(b);
  });

  it("changes when the workflow name changes", () => {
    const a = computeSignature(def({ name: "alpha", steps: [runStep("s")] }));
    const b = computeSignature(def({ name: "beta", steps: [runStep("s")] }));

    expect(a).not.toBe(b);
  });

  it("changes when the version changes", () => {
    const v1 = computeSignature(
      def({ name: "wf", version: "1", steps: [runStep("s")] }),
    );
    const v2 = computeSignature(
      def({ name: "wf", version: "2", steps: [runStep("s")] }),
    );

    expect(v1).not.toBe(v2);
  });

  it("treats omitted version as null — distinct from any explicit version", () => {
    const omitted = computeSignature(def({ name: "wf", steps: [runStep("s")] }));
    const explicit = computeSignature(
      def({ name: "wf", version: "1", steps: [runStep("s")] }),
    );

    expect(omitted).not.toBe(explicit);
  });

  it("ignores description — a cosmetic change keeps the signature stable", () => {
    const withoutDesc = computeSignature(
      def({ name: "wf", steps: [runStep("s")] }),
    );
    const withDesc = computeSignature(
      def({ name: "wf", description: "does things", steps: [runStep("s")] }),
    );

    expect(withDesc).toBe(withoutDesc);
  });

  it("changes when a step is added", () => {
    const one = computeSignature(def({ name: "wf", steps: [runStep("a")] }));
    const two = computeSignature(
      def({ name: "wf", steps: [runStep("a"), runStep("b")] }),
    );

    expect(one).not.toBe(two);
  });

  it("changes when a step is renamed", () => {
    const a = computeSignature(def({ name: "wf", steps: [runStep("a")] }));
    const b = computeSignature(def({ name: "wf", steps: [runStep("renamed")] }));

    expect(a).not.toBe(b);
  });

  it("changes when step order is swapped (order is structural)", () => {
    const ab = computeSignature(
      def({ name: "wf", steps: [runStep("a"), runStep("b")] }),
    );
    const ba = computeSignature(
      def({ name: "wf", steps: [runStep("b"), runStep("a")] }),
    );

    expect(ab).not.toBe(ba);
  });

  it("distinguishes step type — a run step vs an empty step of the same name", () => {
    const runType = computeSignature(
      def({ name: "wf", steps: [{ name: "s", run: () => undefined }] }),
    );
    const emptyType = computeSignature(
      def({ name: "wf", steps: [{ name: "s" }] }),
    );

    expect(runType).not.toBe(emptyType);
  });

  it("distinguishes an agent step from a run step of the same name", () => {
    const agentStep: StepDefinition = {
      name: "s",
      agent: { name: "writer" } as StepDefinition["agent"],
      input: () => ({ prompt: "hi" }),
    };
    const agentType = computeSignature(def({ name: "wf", steps: [agentStep] }));
    const runType = computeSignature(def({ name: "wf", steps: [runStep("s")] }));

    expect(agentType).not.toBe(runType);
  });

  it("includes the agent name in an agent step's fingerprint", () => {
    const writer: StepDefinition = {
      name: "s",
      agent: { name: "writer" } as StepDefinition["agent"],
      input: () => ({ prompt: "hi" }),
    };
    const editor: StepDefinition = {
      name: "s",
      agent: { name: "editor" } as StepDefinition["agent"],
      input: () => ({ prompt: "hi" }),
    };

    expect(computeSignature(def({ name: "wf", steps: [writer] }))).not.toBe(
      computeSignature(def({ name: "wf", steps: [editor] })),
    );
  });

  it("tags a parallel step distinctly and recurses into children", () => {
    const parallel: StepDefinition = {
      name: "fan",
      parallel: [runStep("a"), runStep("b")],
    };
    const sig = computeSignature(def({ name: "wf", steps: [parallel] }));

    expect(sig).toMatch(/^[0-9a-f]{8}$/);

    // Renaming a parallel child changes the signature — children are
    // part of the structural fingerprint.
    const altered: StepDefinition = {
      name: "fan",
      parallel: [runStep("a"), runStep("c")],
    };
    expect(computeSignature(def({ name: "wf", steps: [altered] }))).not.toBe(
      sig,
    );
  });

  it("parallel child order is structural", () => {
    const ab: StepDefinition = {
      name: "fan",
      parallel: [runStep("a"), runStep("b")],
    };
    const ba: StepDefinition = {
      name: "fan",
      parallel: [runStep("b"), runStep("a")],
    };

    expect(computeSignature(def({ name: "wf", steps: [ab] }))).not.toBe(
      computeSignature(def({ name: "wf", steps: [ba] })),
    );
  });

  it("a parallel step with no children differs from one with children", () => {
    const empty: StepDefinition = { name: "fan", parallel: [] };
    const full: StepDefinition = { name: "fan", parallel: [runStep("a")] };

    expect(computeSignature(def({ name: "wf", steps: [empty] }))).not.toBe(
      computeSignature(def({ name: "wf", steps: [full] })),
    );
  });

  it("an empty workflow (no steps) hashes deterministically", () => {
    const a = computeSignature(def({ name: "wf" }));
    const b = computeSignature(def({ name: "wf" }));

    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });
});
