import type { AgentContract } from "../contracts/agent/agent.contract";
import type { AgentResult } from "../contracts/result/agent-result.type";
import type { MiddlewareToolContext } from "../contracts/middleware/middleware-context.type";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, PendingInterrupt } from "./contracts";
import { createApprovalBindingKey, stableStringify } from "./approval-binding";
import { humanApproval } from "./human-approval";
import { resume } from "./resume";
import { memory } from "./stores/memory";

function makeContext(sessionId: string, input: unknown): MiddlewareToolContext {
  return {
    agent: { name: "support", isAnonymous: false },
    model: { name: "mock" },
    input: "refund",
    options: { sessionId },
    state: new Map<string, unknown>(),
    tripIndex: 0,
    messages: [],
    tool: { name: "refundCustomer", description: "Refund" },
    request: { id: "call", name: "refundCustomer", input },
  };
}

function makePending(sessionId: string, args: unknown): PendingInterrupt {
  const request: ApprovalRequest = {
    interruptId: `support.${sessionId}.0.pending`,
    bindingKey: createApprovalBindingKey({
      agentName: "support",
      sessionId,
      toolName: "refundCustomer",
      args,
    }),
    toolName: "refundCustomer",
    args,
    context: { agentName: "support", tripIndex: 0, sessionId, originalInput: "refund" },
    requestedAt: new Date().toISOString(),
  };

  return {
    interruptId: request.interruptId,
    request,
    status: "pending",
    savedAt: new Date().toISOString(),
  };
}

function makeAgent(before: (ctx: MiddlewareToolContext) => Promise<void>, context: MiddlewareToolContext): AgentContract {
  return {
    name: "support",
    isAnonymous: false,
    execute: vi.fn(async () => {
      await before(context);
      return { text: "done" } as AgentResult;
    }),
  } as unknown as AgentContract;
}

describe("approval binding", () => {
  it("does not apply approval from session A to session B", async () => {
    const store = memory();
    const pending = makePending("session-a", { amount: 50 });
    await store.save(pending);
    const handler = vi.fn(() => ({ type: "reject" as const, reason: "needs approval" }));
    const gate = humanApproval({ policy: { type: "allowlist", tools: ["refundCustomer"] }, handler });
    const agent = makeAgent(async (ctx) => {
      await gate.tool!.before!(ctx);
    }, makeContext("session-b", { amount: 50 }));

    await resume(pending.interruptId, { type: "approve" }, { store, agent });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not apply approval for args A to args B", async () => {
    const store = memory();
    const pending = makePending("session-a", { amount: 50 });
    await store.save(pending);
    const handler = vi.fn(() => ({ type: "reject" as const, reason: "needs approval" }));
    const gate = humanApproval({ policy: { type: "allowlist", tools: ["refundCustomer"] }, handler });
    const agent = makeAgent(async (ctx) => {
      await gate.tool!.before!(ctx);
    }, makeContext("session-a", { amount: 500 }));

    await resume(pending.interruptId, { type: "approve" }, { store, agent });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("resumes the approved call exactly once", async () => {
    const store = memory();
    const pending = makePending("session-a", { amount: 50 });
    await store.save(pending);
    const handler = vi.fn(() => ({ type: "reject" as const, reason: "must not run" }));
    const gate = humanApproval({ policy: { type: "allowlist", tools: ["refundCustomer"] }, handler });
    const context = makeContext("session-a", { amount: 50 });
    const agent = makeAgent(async (ctx) => {
      await gate.tool!.before!(ctx);
    }, context);

    await resume(pending.interruptId, { type: "approve" }, { store, agent });

    expect(handler).not.toHaveBeenCalled();
  });

  it("makes binding keys independent of object key order", () => {
    const first = { agentName: "support", sessionId: "session-a", toolName: "refundCustomer", args: { amount: 50, orderId: "a" } };
    const second = { toolName: "refundCustomer", args: { orderId: "a", amount: 50 }, sessionId: "session-a", agentName: "support" };

    expect(stableStringify(first)).toBe(stableStringify(second));
    expect(createApprovalBindingKey(first)).toBe(createApprovalBindingKey(second));
  });
});
