import { describe, expect, it } from "vitest";
import { ai } from "../ai";
import { humanApproval } from "./human-approval";
import { resume } from "./resume";
import { interruptMemory } from "./stores";

describe("ai.human registration", () => {
  it("attaches the human namespace to the shared ai object", () => {
    expect(ai.human).toBeTypeOf("object");
  });

  it("exposes approval / resume as functions", () => {
    expect(ai.human.approval).toBeTypeOf("function");
    expect(ai.human.resume).toBeTypeOf("function");
  });

  it("exposes the interrupt store factories as functions", () => {
    expect(ai.human.interrupt.memory).toBeTypeOf("function");
    expect(ai.human.interrupt.pg).toBeTypeOf("function");
    expect(ai.human.interrupt.redis).toBeTypeOf("function");
  });

  it("registers the same function references the package exports", () => {
    expect(ai.human.approval).toBe(humanApproval);
    expect(ai.human.resume).toBe(resume);
    expect(ai.human.interrupt.memory).toBe(interruptMemory);
  });

  it("ai.human.interrupt.memory() builds a working InterruptStore", async () => {
    const store = ai.human.interrupt.memory();

    expect(store.schema()).toBe("");
    expect(await store.load("nope")).toBeUndefined();
  });

  it("ai.human.approval(...) builds a tool.before middleware", () => {
    const mw = ai.human.approval({
      policy: { type: "allowlist", tools: ["refundCustomer"] },
      handler: () => ({ type: "approve" }),
    });

    expect(mw.name).toBe("human-approval");
    expect(mw.tool?.before).toBeTypeOf("function");
  });
});
