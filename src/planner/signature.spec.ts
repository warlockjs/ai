import { describe, expect, it } from "vitest";
import type { PlannerCapability } from "../contracts/planner/planner-capability.type";
import { mockAgent } from "../mock/mock-agent";
import { computeSignature } from "./signature";

/** Build a capability with the given name — executable is irrelevant to the signature. */
function cap(name: string): PlannerCapability {
  return { name, description: "d", executable: mockAgent({ name: `exec-${name}` }) };
}

describe("planner computeSignature", () => {
  it("is stable for the same name + ordered capabilities", () => {
    const a = computeSignature("p", [cap("search"), cap("write")]);
    const b = computeSignature("p", [cap("search"), cap("write")]);

    expect(a).toBe(b);
    expect(a).toContain("planner:p");
  });

  it("changes when capability order changes", () => {
    const forward = computeSignature("p", [cap("search"), cap("write")]);
    const reversed = computeSignature("p", [cap("write"), cap("search")]);

    expect(forward).not.toBe(reversed);
  });

  it("does not collide a single name 'a,b' with the pair ['a','b']", () => {
    // A comma delimiter would render BOTH as `caps:a,b`, falsely
    // treating two structurally-different planners as identical. The
    // safe delimiter keeps these distinct.
    const single = computeSignature("p", [cap("a,b")]);
    const pair = computeSignature("p", [cap("a"), cap("b")]);

    expect(single).not.toBe(pair);
  });
});
