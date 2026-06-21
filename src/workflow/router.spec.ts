import { describe, expect, it } from "vitest";
import type { StepDefinition } from "../contracts/workflow/step.contract";
import type { WorkflowDefinition } from "../contracts/workflow/workflow.contract";
import { mapNextStep, nextDeclaredStep } from "./router";

/** Minimal definition carrying only the `steps` the helpers read. */
function def(stepNames: string[]): WorkflowDefinition {
  return {
    name: "wf",
    steps: stepNames.map(name => ({ name }) as StepDefinition),
  } as WorkflowDefinition;
}

describe("mapNextStep", () => {
  it("maps `{ end: true }` to the 'end' sentinel string", () => {
    expect(mapNextStep({ end: true })).toBe("end");
  });

  it("maps `{ goto: name }` to the target step name", () => {
    expect(mapNextStep({ goto: "review" })).toBe("review");
  });

  it("returns undefined for a void / undefined outcome (fall through)", () => {
    expect(mapNextStep(undefined)).toBeUndefined();
    expect(mapNextStep(undefined as never)).toBeUndefined();
  });

  it("returns undefined for an object that declares neither end nor goto", () => {
    expect(mapNextStep({} as never)).toBeUndefined();
  });

  it("ignores `{ end: false }` (only end:true terminates)", () => {
    expect(mapNextStep({ end: false } as never)).toBeUndefined();
  });

  it("ignores a non-string goto value", () => {
    expect(mapNextStep({ goto: 123 } as never)).toBeUndefined();
  });
});

describe("nextDeclaredStep", () => {
  it("returns the name of the step following the current one", () => {
    expect(nextDeclaredStep(def(["a", "b", "c"]), "a")).toBe("b");
    expect(nextDeclaredStep(def(["a", "b", "c"]), "b")).toBe("c");
  });

  it("returns null after the last declared step", () => {
    expect(nextDeclaredStep(def(["a", "b"]), "b")).toBeNull();
  });

  it("returns null when the current step name is not in the definition", () => {
    expect(nextDeclaredStep(def(["a", "b"]), "ghost")).toBeNull();
  });

  it("returns null for a single-step workflow", () => {
    expect(nextDeclaredStep(def(["only"]), "only")).toBeNull();
  });
});
