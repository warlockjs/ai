import type { AgentContract } from "../contracts/agent/agent.contract";
import type { MiddlewareToolContext } from "../contracts/middleware/middleware-context.type";
import type { AgentResult } from "../contracts/result/agent-result.type";
import type { ToolInvokeResult } from "../tool/tool";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, PendingInterrupt } from "./contracts";
import { humanApproval } from "./human-approval";
import { resume } from "./resume";
import { memory } from "./stores/memory";

/**
 * Build a {@link PendingInterrupt} fixture, overridable per field. The
 * embedded request is the durable payload `resume(...)` rules on.
 */
function makeInterrupt(
  overrides: Partial<PendingInterrupt> = {},
): PendingInterrupt {
  const request: ApprovalRequest = {
    interruptId: "support.sess-1.0.abc",
    toolName: "refundCustomer",
    toolDescription: "Refund a customer order",
    args: { orderId: "4821", amount: 50 },
    context: {
      agentName: "support",
      tripIndex: 0,
      sessionId: "sess-1",
      originalInput: "Refund order #4821",
      tags: ["money"],
    },
    requestedAt: new Date().toISOString(),
  };

  return {
    interruptId: "support.sess-1.0.abc",
    request,
    status: "pending",
    savedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Fabricate a {@link MiddlewareToolContext} for a single tool call. Only
 * the fields the approval middleware reads are populated.
 */
function makeToolContext(
  overrides: { input?: string; agentName?: string } = {},
): MiddlewareToolContext {
  const { input = "Refund order #4821", agentName = "support" } = overrides;

  return {
    agent: { name: agentName, isAnonymous: false },
    model: { name: "mock-model" },
    input,
    options: undefined,
    state: new Map<string, unknown>(),
    tripIndex: 0,
    messages: [],
    tool: { name: "refundCustomer", description: "Refund a customer order" },
    request: { id: "call_1", name: "refundCustomer", input: { amount: 50 } },
  };
}

/**
 * Minimal fake {@link AgentContract} — `resume`'s re-run path only reads
 * `agent.name` and calls `agent.execute(input, options)`. `execute` is a
 * spy returning a canned {@link AgentResult}. The optional `before` hook is
 * fired inside `execute` so a test can observe the seeded decision flowing
 * through the real `humanApproval` middleware.
 */
function makeFakeAgent(opts: {
  name?: string;
  before?: (ctx: MiddlewareToolContext) => Promise<ToolInvokeResult<unknown> | void>;
  toolContext?: MiddlewareToolContext;
} = {}): { agent: AgentContract; execute: ReturnType<typeof vi.fn> } {
  const { name = "support", before, toolContext } = opts;

  const cannedResult: AgentResult = {
    type: "agent",
    text: "done",
    usage: { input: 0, output: 0, total: 0 },
    report: {
      runId: "agent_x",
      rootRunId: "agent_x",
      name,
      type: "agent",
      status: "completed",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      duration: 0,
      usage: { input: 0, output: 0, total: 0 },
      children: [],
      trips: [],
      toolCalls: [],
    } as unknown as AgentResult["report"],
  };

  const execute = vi.fn(async (input: string) => {
    // Drive the gated tool call exactly as the agent runtime would, so the
    // seeded decision is consumed through the real middleware hook.
    if (before) {
      await before(toolContext ?? makeToolContext({ input, agentName: name }));
    }

    return cannedResult;
  });

  const agent = {
    name,
    isAnonymous: false,
    execute,
  } as unknown as AgentContract;

  return { agent, execute };
}

describe("resume", () => {
  describe("idempotency", () => {
    it("returns already-resolved for an interrupt that was never raised", async () => {
      const store = memory();

      const outcome = await resume("ghost", { type: "approve" }, { store });

      expect(outcome).toEqual({ type: "already-resolved", interruptId: "ghost" });
    });

    it("returns already-resolved for an interrupt already marked resolved", async () => {
      const store = memory();
      await store.save(makeInterrupt({ status: "resolved" }));

      const outcome = await resume(
        "support.sess-1.0.abc",
        { type: "approve" },
        { store },
      );

      expect(outcome).toEqual({
        type: "already-resolved",
        interruptId: "support.sess-1.0.abc",
      });
    });

    it("does not re-apply on a second resume of the same id", async () => {
      const store = memory();
      await store.save(makeInterrupt());

      const first = await resume(
        "support.sess-1.0.abc",
        { type: "approve" },
        { store },
      );
      const second = await resume(
        "support.sess-1.0.abc",
        { type: "approve" },
        { store },
      );

      expect(first.type).toBe("applied");
      expect(second.type).toBe("already-resolved");
    });
  });

  describe("apply-only (no agent)", () => {
    it("loads, deletes, and returns the approve decision", async () => {
      const store = memory();
      await store.save(makeInterrupt());

      const outcome = await resume(
        "support.sess-1.0.abc",
        { type: "approve" },
        { store },
      );

      expect(outcome).toEqual({
        type: "applied",
        interruptId: "support.sess-1.0.abc",
        decision: { type: "approve" },
      });
      // Pending record deleted.
      expect(await store.load("support.sess-1.0.abc")).toBeUndefined();
    });

    it("carries a reject decision (with reason) through", async () => {
      const store = memory();
      await store.save(makeInterrupt());

      const outcome = await resume(
        "support.sess-1.0.abc",
        { type: "reject", reason: "Out of policy" },
        { store },
      );

      expect(outcome).toMatchObject({
        type: "applied",
        decision: { type: "reject", reason: "Out of policy" },
      });
    });

    it("carries an edit decision (with replacement args) through", async () => {
      const store = memory();
      await store.save(makeInterrupt());

      const outcome = await resume(
        "support.sess-1.0.abc",
        { type: "edit", args: { amount: 5 } },
        { store },
      );

      expect(outcome).toMatchObject({
        type: "applied",
        decision: { type: "edit", args: { amount: 5 } },
      });
    });
  });

  describe("decision validation", () => {
    it("rejects a 'reject' decision missing a string reason", async () => {
      const store = memory();
      await store.save(makeInterrupt());

      await expect(
        resume(
          "support.sess-1.0.abc",
          { type: "reject" } as never,
          { store },
        ),
      ).rejects.toThrow(/requires a string 'reason'/);
    });

    it("rejects an unknown decision type", async () => {
      const store = memory();
      await store.save(makeInterrupt());

      await expect(
        resume(
          "support.sess-1.0.abc",
          { type: "nuke" } as never,
          { store },
        ),
      ).rejects.toThrow(/unknown decision type/);
    });
  });

  describe("re-run (with agent, decision pre-seeded)", () => {
    it("re-executes the original prompt and returns the agent result", async () => {
      const store = memory();
      await store.save(makeInterrupt());

      const { agent, execute } = makeFakeAgent();

      const outcome = await resume(
        "support.sess-1.0.abc",
        { type: "approve" },
        { store, agent },
      );

      expect(execute).toHaveBeenCalledTimes(1);
      // Defaults the re-run prompt to the captured original input.
      expect(execute).toHaveBeenCalledWith("Refund order #4821", undefined);
      expect(outcome.type).toBe("applied");

      if (outcome.type !== "applied") {
        return;
      }

      expect(outcome.result?.text).toBe("done");
    });

    it("honors an input override for the re-run prompt", async () => {
      const store = memory();
      await store.save(makeInterrupt());

      const { agent, execute } = makeFakeAgent();

      await resume(
        "support.sess-1.0.abc",
        { type: "approve" },
        { store, agent, input: "Refund order #4821 (approved by ops)" },
      );

      expect(execute).toHaveBeenCalledWith(
        "Refund order #4821 (approved by ops)",
        undefined,
      );
    });

    it("pre-seeds the decision so the gated tool call resolves to the ruling (edit)", async () => {
      const store = memory();
      await store.save(makeInterrupt());

      // A real approval middleware whose author handler would normally
      // suspend — but the seeded decision must short-circuit it.
      const authorHandler = vi.fn(() => {
        throw new Error("author handler should not run on a seeded re-run");
      });
      const mw = humanApproval({
        policy: { type: "allowlist", tools: ["refundCustomer"] },
        handler: authorHandler,
      });

      const toolContext = makeToolContext();
      const { agent } = makeFakeAgent({
        before: async (ctx) => mw.tool!.before!(ctx),
        toolContext,
      });

      await resume(
        "support.sess-1.0.abc",
        { type: "edit", args: { amount: 5 } },
        { store, agent },
      );

      // The author handler never ran; the seeded edit rewrote the args.
      expect(authorHandler).not.toHaveBeenCalled();
      expect(toolContext.request.input).toEqual({ amount: 5 });
    });

    it("pre-seeds an approve so the gated call runs unchanged", async () => {
      const store = memory();
      await store.save(makeInterrupt());

      const authorHandler = vi.fn(() => {
        throw new Error("author handler should not run on a seeded re-run");
      });
      const mw = humanApproval({
        policy: { type: "allowlist", tools: ["refundCustomer"] },
        handler: authorHandler,
      });

      const toolContext = makeToolContext();
      let beforeReturn: ToolInvokeResult<unknown> | void = undefined;
      const { agent } = makeFakeAgent({
        before: async (ctx) => {
          beforeReturn = await mw.tool!.before!(ctx);

          return beforeReturn;
        },
        toolContext,
      });

      await resume(
        "support.sess-1.0.abc",
        { type: "approve" },
        { store, agent },
      );

      expect(authorHandler).not.toHaveBeenCalled();
      // approve → void (real tool runs), args untouched.
      expect(beforeReturn).toBeUndefined();
      expect(toolContext.request.input).toEqual({ amount: 50 });
    });

    it("deletes the pending record before the re-run", async () => {
      const store = memory();
      await store.save(makeInterrupt());

      const { agent } = makeFakeAgent({
        before: async () => {
          // By the time the re-run is in flight, the original record is gone.
          expect(await store.load("support.sess-1.0.abc")).toBeUndefined();
        },
        toolContext: makeToolContext(),
      });

      await resume(
        "support.sess-1.0.abc",
        { type: "approve" },
        { store, agent },
      );
    });

    it("does not leak a stale seed when the gated call never fires", async () => {
      const store = memory();
      await store.save(makeInterrupt());

      // A re-run whose agent does NOT exercise the gated tool (no `before`).
      const { agent } = makeFakeAgent();

      await resume(
        "support.sess-1.0.abc",
        { type: "edit", args: { amount: 5 } },
        { store, agent },
      );

      // A fresh, unrelated gated call must NOT pick up the stale seed — it
      // should reach the author handler.
      const authorHandler = vi.fn(() => ({ type: "reject" as const, reason: "no" }));
      const mw = humanApproval({
        policy: { type: "allowlist", tools: ["refundCustomer"] },
        handler: authorHandler,
      });

      await mw.tool!.before!(makeToolContext());

      expect(authorHandler).toHaveBeenCalledTimes(1);
    });
  });
});
