import type { MiddlewareToolContext } from "../contracts/middleware/middleware-context.type";
import type { ToolInvokeResult } from "../tool/tool";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalDecision, ApprovalRequest } from "./contracts";
import { ApprovalRejectedError, InterruptSuspendedError } from "./errors";
import { humanApproval } from "./human-approval";

/**
 * Fabricate a {@link MiddlewareToolContext} for a single tool call,
 * standing in for the one the agent dispatch builds. Only the fields the
 * approval middleware reads are populated.
 */
function makeToolContext(
  overrides: {
    toolName?: string;
    toolDescription?: string;
    input?: unknown;
    agentName?: string;
    tripIndex?: number;
    sessionId?: string;
  } = {},
): MiddlewareToolContext {
  const {
    toolName = "refundCustomer",
    toolDescription = "Refund a customer order",
    input = { amount: 50 },
    agentName = "support",
    tripIndex = 0,
    sessionId,
  } = overrides;

  return {
    agent: { name: agentName, isAnonymous: false },
    model: { name: "mock-model" },
    input: "Refund order #4821",
    options: sessionId ? { sessionId } : undefined,
    state: new Map<string, unknown>(),
    tripIndex,
    messages: [],
    tool: { name: toolName, description: toolDescription },
    request: { id: "call_1", name: toolName, input },
  };
}

/** Type guard narrowing a `before` return to a short-circuit result. */
function isResult(
  value: ToolInvokeResult<unknown> | void,
): value is ToolInvokeResult<unknown> {
  return value !== undefined;
}

describe("humanApproval", () => {
  it("defaults the middleware name and declares only a tool.before hook", () => {
    const mw = humanApproval({
      policy: { type: "allowlist", tools: [] },
      handler: () => ({ type: "approve" }),
    });

    expect(mw.name).toBe("human-approval");
    expect(mw.tool?.before).toBeTypeOf("function");
    expect(mw.tool?.after).toBeUndefined();
    expect(mw.execute).toBeUndefined();
    expect(mw.trip).toBeUndefined();
  });

  it("honors a custom middleware name", () => {
    const mw = humanApproval({
      name: "refund-gate",
      policy: { type: "allowlist", tools: [] },
      handler: () => ({ type: "approve" }),
    });

    expect(mw.name).toBe("refund-gate");
  });

  it("passes an un-gated tool through untouched (handler never called)", async () => {
    const handler = vi.fn<(r: ApprovalRequest) => ApprovalDecision>();
    const mw = humanApproval({
      policy: { type: "allowlist", tools: ["deleteAccount"] },
      handler,
    });

    const ctx = makeToolContext({ toolName: "refundCustomer" });
    const out = await mw.tool!.before!(ctx);

    expect(out).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it("gates via a denylist (every tool except the listed ones)", async () => {
    const handler = vi.fn<(r: ApprovalRequest) => ApprovalDecision>(() => ({
      type: "approve",
    }));
    const mw = humanApproval({
      policy: { type: "denylist", tools: ["lookupOrder"] },
      handler,
    });

    await mw.tool!.before!(makeToolContext({ toolName: "refundCustomer" }));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("gates via a predicate", async () => {
    const handler = vi.fn<(r: ApprovalRequest) => ApprovalDecision>(() => ({
      type: "approve",
    }));
    const mw = humanApproval({
      policy: {
        type: "predicate",
        requiresApproval: c => c.toolName === "refundCustomer",
      },
      handler,
    });

    await mw.tool!.before!(makeToolContext());
    await mw.tool!.before!(makeToolContext({ toolName: "lookupOrder" }));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("builds an ApprovalRequest carrying args, toolName, and tagged context", async () => {
    let captured: ApprovalRequest | undefined;
    const mw = humanApproval({
      policy: {
        type: "allowlist",
        tools: ["refundCustomer"],
        tags: () => ["money"],
      },
      handler: req => {
        captured = req;

        return { type: "approve" };
      },
    });

    await mw.tool!.before!(
      makeToolContext({ input: { amount: 99 }, tripIndex: 2, sessionId: "sess-7" }),
    );

    expect(captured).toMatchObject({
      toolName: "refundCustomer",
      toolDescription: "Refund a customer order",
      args: { amount: 99 },
      context: {
        agentName: "support",
        tripIndex: 2,
        sessionId: "sess-7",
        tags: ["money"],
      },
    });
    expect(captured?.interruptId).toContain("support.sess-7.2.");
    expect(typeof captured?.requestedAt).toBe("string");
  });

  describe("approve", () => {
    it("returns void so the real tool runs unchanged", async () => {
      const mw = humanApproval({
        policy: { type: "allowlist", tools: ["refundCustomer"] },
        handler: () => ({ type: "approve" }),
      });

      const ctx = makeToolContext({ input: { amount: 50 } });
      const out = await mw.tool!.before!(ctx);

      expect(out).toBeUndefined();
      // Args are untouched on approve.
      expect(ctx.request.input).toEqual({ amount: 50 });
    });
  });

  describe("reject", () => {
    it("short-circuits a failed result carrying ApprovalRejectedError + reason (never throws)", async () => {
      const mw = humanApproval({
        policy: { type: "allowlist", tools: ["refundCustomer"] },
        handler: () => ({ type: "reject", reason: "Out of policy" }),
      });

      const out = await mw.tool!.before!(makeToolContext());

      expect(isResult(out)).toBe(true);

      if (!isResult(out)) {
        return;
      }

      expect(out.data).toBeUndefined();
      expect(out.error).toBeInstanceOf(ApprovalRejectedError);
      expect((out.error as ApprovalRejectedError).reason).toBe("Out of policy");
      expect((out.error as ApprovalRejectedError).toolName).toBe("refundCustomer");
      expect(out.report.status).toBe("failed");
      expect(out.report.type).toBe("tool");
    });
  });

  describe("edit", () => {
    it("rewrites ctx.request.input and returns void so the tool runs with edited args", async () => {
      const mw = humanApproval({
        policy: { type: "allowlist", tools: ["refundCustomer"] },
        handler: () => ({ type: "edit", args: { amount: 5 } }),
      });

      const ctx = makeToolContext({ input: { amount: 500 } });
      const out = await mw.tool!.before!(ctx);

      expect(out).toBeUndefined();
      expect(ctx.request.input).toEqual({ amount: 5 });
    });
  });

  describe("durable suspend", () => {
    it("catches its own InterruptSuspendedError and short-circuits it onto result.error", async () => {
      const interruptId = "support.nosession.0.x";
      const mw = humanApproval({
        policy: { type: "allowlist", tools: ["refundCustomer"] },
        handler: () => {
          throw new InterruptSuspendedError("suspended", { interruptId });
        },
      });

      const out = await mw.tool!.before!(makeToolContext());

      expect(isResult(out)).toBe(true);

      if (!isResult(out)) {
        return;
      }

      expect(out.error).toBeInstanceOf(InterruptSuspendedError);
      expect((out.error as InterruptSuspendedError).interruptId).toBe(interruptId);
      expect(out.report.status).toBe("failed");
    });

    it("re-throws a non-sentinel handler error (a bug is never swallowed into approval)", async () => {
      const mw = humanApproval({
        policy: { type: "allowlist", tools: ["refundCustomer"] },
        handler: () => {
          throw new Error("handler crashed");
        },
      });

      await expect(mw.tool!.before!(makeToolContext())).rejects.toThrow(
        "handler crashed",
      );
    });
  });

  it("awaits an async handler decision in-process", async () => {
    const mw = humanApproval({
      policy: { type: "allowlist", tools: ["refundCustomer"] },
      handler: async () => {
        await Promise.resolve();

        return { type: "edit", args: { amount: 1 } };
      },
    });

    const ctx = makeToolContext({ input: { amount: 999 } });
    await mw.tool!.before!(ctx);

    expect(ctx.request.input).toEqual({ amount: 1 });
  });
});
