import { describe, expect, it } from "vitest";
import type { InterruptPolicy, PolicyContext } from "./contracts";
import { evaluatePolicy } from "./policy";

/** A minimal policy context for a single fabricated tool call. */
function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    toolName: "refundCustomer",
    args: { amount: 50 },
    agentName: "support",
    tripIndex: 0,
    ...overrides,
  };
}

describe("evaluatePolicy", () => {
  describe("allowlist", () => {
    it("gates a call whose tool name is listed", () => {
      const policy: InterruptPolicy = {
        type: "allowlist",
        tools: ["refundCustomer", "deleteAccount"],
      };

      expect(evaluatePolicy(policy, ctx())).toEqual({ requiresApproval: true });
    });

    it("skips a call whose tool name is NOT listed", () => {
      const policy: InterruptPolicy = {
        type: "allowlist",
        tools: ["deleteAccount"],
      };

      expect(evaluatePolicy(policy, ctx())).toEqual({ requiresApproval: false });
    });

    it("surfaces tags from the tags() callback for a gated call", () => {
      const policy: InterruptPolicy = {
        type: "allowlist",
        tools: ["refundCustomer"],
        tags: name => (name === "refundCustomer" ? ["money"] : []),
      };

      expect(evaluatePolicy(policy, ctx())).toEqual({
        requiresApproval: true,
        tags: ["money"],
      });
    });

    it("omits tags when the tags() callback returns an empty array", () => {
      const policy: InterruptPolicy = {
        type: "allowlist",
        tools: ["refundCustomer"],
        tags: () => [],
      };

      expect(evaluatePolicy(policy, ctx())).toEqual({ requiresApproval: true });
    });
  });

  describe("denylist", () => {
    it("skips a call whose tool name is listed (allowed through)", () => {
      const policy: InterruptPolicy = {
        type: "denylist",
        tools: ["lookupOrder"],
      };

      expect(evaluatePolicy(policy, ctx({ toolName: "lookupOrder" }))).toEqual({
        requiresApproval: false,
      });
    });

    it("gates every call NOT on the list", () => {
      const policy: InterruptPolicy = {
        type: "denylist",
        tools: ["lookupOrder"],
      };

      expect(evaluatePolicy(policy, ctx())).toEqual({ requiresApproval: true });
    });

    it("derives tags for the gated (non-listed) tool name", () => {
      const policy: InterruptPolicy = {
        type: "denylist",
        tools: ["lookupOrder"],
        tags: name => [`tool:${name}`],
      };

      expect(evaluatePolicy(policy, ctx())).toEqual({
        requiresApproval: true,
        tags: ["tool:refundCustomer"],
      });
    });
  });

  describe("predicate", () => {
    it("skips when the predicate returns false", () => {
      const policy: InterruptPolicy = {
        type: "predicate",
        requiresApproval: () => false,
      };

      expect(evaluatePolicy(policy, ctx())).toEqual({ requiresApproval: false });
    });

    it("gates with no tags when the predicate returns true", () => {
      const policy: InterruptPolicy = {
        type: "predicate",
        requiresApproval: c => c.toolName === "refundCustomer",
      };

      expect(evaluatePolicy(policy, ctx())).toEqual({ requiresApproval: true });
    });

    it("gates AND surfaces tags when the predicate returns a non-empty string[]", () => {
      const policy: InterruptPolicy = {
        type: "predicate",
        requiresApproval: c =>
          (c.args as { amount: number }).amount > 10 ? ["high-value"] : false,
      };

      expect(evaluatePolicy(policy, ctx())).toEqual({
        requiresApproval: true,
        tags: ["high-value"],
      });
    });

    it("skips when the predicate returns an empty string[] (no rule matched)", () => {
      const policy: InterruptPolicy = {
        type: "predicate",
        requiresApproval: () => [],
      };

      expect(evaluatePolicy(policy, ctx())).toEqual({ requiresApproval: false });
    });

    it("passes the full context to the predicate", () => {
      let seen: PolicyContext | undefined;
      const policy: InterruptPolicy = {
        type: "predicate",
        requiresApproval: c => {
          seen = c;

          return false;
        },
      };

      evaluatePolicy(policy, ctx({ sessionId: "sess-1", tripIndex: 3 }));

      expect(seen).toMatchObject({
        toolName: "refundCustomer",
        agentName: "support",
        tripIndex: 3,
        sessionId: "sess-1",
      });
    });
  });
});
