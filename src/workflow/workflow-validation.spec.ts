import { describe, expect, it } from "vitest";
import { WorkflowError } from "../errors";
import { mockAgent } from "../mock/mock-agent";
import { step } from "./step";
import { workflow } from "./workflow";

describe("ai.workflow — authoring validation", () => {
  it("throws WorkflowError on duplicate step name", () => {
    expect(() =>
      workflow({
        name: "dup",
        steps: [
          step({ name: "a", run: () => {} }),
          step({ name: "a", run: () => {} }),
        ],
      }),
    ).toThrow(WorkflowError);
  });

  it("ai.step throws WorkflowError when name missing", () => {
    expect(() => step({ name: "", run: () => {} } as any)).toThrow(
      WorkflowError,
    );
  });

  it("ai.step throws WorkflowError when both run and agent are set", () => {
    const dummyAgent = {
      execute: async () => ({}) as any,
    } as any;

    expect(() =>
      step({
        name: "hybrid",
        run: () => {},
        agent: dummyAgent,
        input: () => ({ prompt: "" }),
      }),
    ).toThrow(WorkflowError);
  });

  it("ai.step throws WorkflowError when no mode is set", () => {
    expect(() => step({ name: "empty" } as any)).toThrow(WorkflowError);
  });

  it("ai.step throws WorkflowError when agent is set without input()", () => {
    const dummyAgent = { execute: async () => ({}) as any } as any;
    expect(() => step({ name: "no-input", agent: dummyAgent } as any)).toThrow(
      WorkflowError,
    );
  });

  it("emits workflow.error when snapshot persistence fails", async () => {
    const brokenStore = {
      async load() {
        return undefined;
      },
      async save() {
        throw new Error("disk full");
      },
      async delete() {},
      schema() {
        return "";
      },
    };
    const errors: unknown[] = [];

    const wf = workflow({
      name: "persist-fail",
      // Test-only stub — only `save` is exercised on the persist path,
      // which is exactly what we want to fail.
      snapshotStore: brokenStore,
      on: { "workflow.error": e => errors.push(e) },
      steps: [step({ name: "a", run: () => {} })],
    });

    const result = await wf.execute({ input: {} });
    // Workflow itself still completes — persistence failure is surfaced, not fatal.
    expect(result.report.status).toBe("completed");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("anonymous agents get a deterministic fingerprint (stable across restarts)", () => {
    const a1 = mockAgent({ modelName: "m" });
    const a2 = mockAgent({ modelName: "m" });
    const a3 = mockAgent({ modelName: "different" });

    expect(a1.isAnonymous).toBe(true);
    // Readable: anon_<provider>_<model>[_<tools>]
    expect(a1.name).toMatch(/^anon_[a-zA-Z0-9._-]+_[a-zA-Z0-9._-]+/);
    expect(a1.name).toContain("mock");
    expect(a1.name).toContain("m");
    // Same identity-defining config → same synthetic name.
    expect(a1.name).toBe(a2.name);
    // Different model → different name.
    expect(a1.name).not.toBe(a3.name);
  });

  it("workflow step accepts an anonymous agent (fingerprint is stable)", () => {
    const anon = mockAgent({ modelName: "m" });

    expect(() =>
      step({
        name: "composed",
        agent: anon,
        input: () => ({ prompt: "" }),
      }),
    ).not.toThrow();
  });
});
