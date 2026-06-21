import { describe, expect, it } from "vitest";
import { END } from "../contracts/end.type";
import { SupervisorFailedError } from "../errors";
import { buildScriptedAgent, routerDecision } from "./_test-helpers";
import { supervisor } from "./supervisor";

/**
 * Phase 3.3 stage 3b — callback dispatch runtime. Covers the seven
 * scenarios called out in the rollout plan plus the `state` /
 * `signal` plumbing that callbacks rely on.
 */

describe("ai.supervisor — callback intent dispatch (stage 3b)", () => {
  it("dispatches a bare callback under deterministic route and returns its value", async () => {
    let callCount = 0;

    const sup = supervisor({
      name: "callback-route",
      route: ctx => (ctx.iteration === 0 ? "refund" : END),
      intents: {
        refund: async ctx => {
          callCount += 1;
          return { ok: true, intent: ctx.intent, iteration: ctx.iteration };
        },
      },
    });

    const result = await sup.execute("ignored");

    expect(result.error).toBeUndefined();
    expect(callCount).toBe(1);

    const branch = result.report.snapshots[0]?.result.refund;
    expect(branch?.output).toEqual({
      ok: true,
      intent: "refund",
      iteration: 0,
    });
    expect(branch?.usage).toEqual({ input: 0, output: 0, total: 0 });

    const callbackReport = result.report.children.find(
      child => child.type === "callback",
    );
    expect(callbackReport).toBeDefined();
    expect(callbackReport?.name).toBe("refund");
    expect(callbackReport?.status).toBe("completed");
    expect(callbackReport?.usage).toEqual({ input: 0, output: 0, total: 0 });
    expect(callbackReport?.duration).toBeGreaterThanOrEqual(0);
  });

  it("rejects a bare callback intent when a router is configured", () => {
    const router = buildScriptedAgent({
      name: "router",
      description: "router",
      responses: [{ content: routerDecision(END), finishReason: "stop" }],
    });

    expect(() =>
      supervisor({
        name: "callback-router-bad",
        router,
        intents: {
          refund: async () => "ok",
        },
      }),
    ).toThrow(/needs a description because a `router` is configured/);
  });

  it("accepts a `{ run, description }` entry under a router", async () => {
    const router = buildScriptedAgent({
      name: "router",
      description: "router",
      responses: [
        { content: routerDecision("refund"), finishReason: "stop" },
        { content: routerDecision(END), finishReason: "stop" },
      ],
    });

    const sup = supervisor({
      name: "callback-router-ok",
      router,
      intents: {
        refund: {
          run: async ctx => ({ refunded: true, input: ctx.input }),
          description: "Process a refund via the billing API",
        },
      },
    });

    const result = await sup.execute("user wants a refund");

    expect(result.error).toBeUndefined();
    expect(result.report.snapshots[0]?.result.refund?.output).toEqual({
      refunded: true,
      input: "user wants a refund",
    });
  });

  it("rejects entries that mix `agent` and `run`", () => {
    const dummyAgent = buildScriptedAgent({
      name: "dummy",
      description: "dummy",
      responses: [{ content: "ok", finishReason: "stop" }],
    });

    expect(() =>
      supervisor({
        name: "mixed-bad",
        route: () => END,
        intents: {
          mixed: {
            agent: dummyAgent,
            run: async () => "ok",
          } as any,
        },
      }),
    ).toThrow(/multiple dispatch fields/);
  });

  it("wraps callback throws in SupervisorFailedError and preserves cause", async () => {
    const original = new Error("billing API exploded");
    const sup = supervisor({
      name: "callback-throws",
      route: () => "refund",
      intents: {
        refund: async () => {
          throw original;
        },
      },
      maxIterations: 1,
    });

    const result = await sup.execute("input");

    const branch = result.report.snapshots[0]?.result.refund;
    expect(branch?.error).toBeInstanceOf(SupervisorFailedError);
    expect((branch?.error as SupervisorFailedError | undefined)?.cause).toBe(
      original,
    );
    expect(branch?.error?.message).toMatch(/billing API exploded/);

    const callbackReport = result.report.children.find(
      child => child.type === "callback",
    );
    expect(callbackReport?.status).toBe("failed");
  });

  it("synthesizes a leaf report even when callback returns void", async () => {
    const sup = supervisor({
      name: "callback-void",
      route: ctx => (ctx.iteration === 0 ? "noop" : END),
      intents: {
        noop: async () => {
          /* returns undefined */
        },
      },
    });

    const result = await sup.execute("hello");

    expect(result.error).toBeUndefined();

    const branch = result.report.snapshots[0]?.result.noop;
    expect(branch?.output).toBeUndefined();
    expect(branch?.error).toBeUndefined();

    const callbackReport = result.report.children.find(
      child => child.type === "callback",
    );
    expect(callbackReport?.status).toBe("completed");
    expect(callbackReport?.duration).toBeGreaterThanOrEqual(0);
  });

  it("fans out a callback alongside an agent and produces both branches", async () => {
    const writer = buildScriptedAgent({
      name: "writer",
      description: "drafts content",
      responses: [{ content: "draft v1", finishReason: "stop" }],
    });

    const router = buildScriptedAgent({
      name: "router",
      description: "router",
      responses: [
        {
          content: JSON.stringify({ next: ["writer", "audit-log"] }),
          finishReason: "stop",
        },
        { content: routerDecision(END), finishReason: "stop" },
      ],
    });

    let auditFired = false;

    const sup = supervisor({
      name: "callback-fanout",
      router,
      intents: {
        writer,
        "audit-log": {
          run: async () => {
            auditFired = true;
            return { logged: true };
          },
          description: "Records the dispatch event in the audit ledger",
        },
      },
    });

    const result = await sup.execute("publish-001");

    expect(result.error).toBeUndefined();
    expect(auditFired).toBe(true);

    const iteration0 = result.report.snapshots[0];
    expect(Object.keys(iteration0?.result ?? {})).toEqual(
      expect.arrayContaining(["writer", "audit-log"]),
    );
    expect(iteration0?.result.writer?.error).toBeUndefined();
    expect(iteration0?.result["audit-log"]?.error).toBeUndefined();
    // Stage 4c — combine dropped. The audit-log callback's return
    // shallow-merged into supervisor state.
    expect(iteration0?.state).toMatchObject({ logged: true });
  });

  it("passes iteration / intent / iterations into DispatchContext", async () => {
    const seen: Array<{
      iteration: number;
      intent: string;
      iterationsLength: number;
    }> = [];

    const sup = supervisor({
      name: "ctx-shape",
      route: ctx => (ctx.iteration < 2 ? "tick" : END),
      intents: {
        tick: async ctx => {
          seen.push({
            iteration: ctx.iteration,
            intent: ctx.intent,
            iterationsLength: ctx.iterations.length,
          });
          return ctx.iteration;
        },
      },
      maxIterations: 5,
    });

    await sup.execute("seed");

    expect(seen).toEqual([
      { iteration: 0, intent: "tick", iterationsLength: 0 },
      { iteration: 1, intent: "tick", iterationsLength: 1 },
    ]);
  });
});

describe("ai.supervisor — ctx.intents.X.execute (Q5/Q6 — replaces ctx.dispatch.byName)", () => {
  it("dispatches a sibling agent and nests its report under children", async () => {
    const helper = buildScriptedAgent({
      name: "helper",
      description: "produces a result",
      responses: [{ content: "helper says hi", finishReason: "stop" }],
    });

    const sup = supervisor({
      name: "byname-agent",
      route: ctx => (ctx.iteration === 0 ? "orchestrate" : END),
      intents: {
        orchestrate: async ctx => {
          const helperOutput = await ctx.intents.helper.execute();
          return { wrapped: helperOutput };
        },
        helper,
      },
    });

    const result = await sup.execute("seed");
    expect(result.error).toBeUndefined();

    const callbackReport = result.report.children.find(
      child => child.type === "callback" && child.name === "orchestrate",
    );

    expect(callbackReport).toBeDefined();
    expect(callbackReport?.children.length).toBe(1);
    expect(callbackReport?.children[0]?.type).toBe("agent");
    expect(callbackReport?.children[0]?.name).toBe("helper");

    // Roll-up: callback's usage must equal the helper agent's usage.
    expect(callbackReport?.usage.total).toBe(
      callbackReport?.children[0]?.usage.total,
    );

    // The dispatched agent's report must NOT also appear at the
    // top level — that would double-count usage.
    const helperAtTop = result.report.children.find(
      child => child.type === "agent" && child.name === "helper",
    );
    expect(helperAtTop).toBeUndefined();
  });

  it("dispatches a sibling callback and nests its report", async () => {
    const sup = supervisor({
      name: "byname-callback",
      route: ctx => (ctx.iteration === 0 ? "outer" : END),
      intents: {
        outer: async ctx => {
          const inner = await ctx.intents.inner.execute();
          return { from: "outer", inner };
        },
        inner: async () => ({ value: 42 }),
      },
    });

    const result = await sup.execute("seed");
    expect(result.error).toBeUndefined();

    const outerReport = result.report.children.find(
      child => child.type === "callback" && child.name === "outer",
    );
    expect(outerReport).toBeDefined();
    expect(outerReport?.children.length).toBe(1);
    expect(outerReport?.children[0]?.type).toBe("callback");
    expect(outerReport?.children[0]?.name).toBe("inner");

    const branch = result.report.snapshots[0]?.result.outer;
    expect(branch?.output).toEqual({ from: "outer", inner: { value: 42 } });
  });

  it("detects a direct cycle (A → A) and throws SUPERVISOR_DISPATCH_CYCLE", async () => {
    const sup = supervisor({
      name: "self-cycle",
      route: () => "loop",
      intents: {
        loop: async ctx => {
          await ctx.intents.loop.execute();
          return "unreachable";
        },
      },
      maxIterations: 1,
    });

    const result = await sup.execute("seed");
    const branch = result.report.snapshots[0]?.result.loop;
    const error = branch?.error as SupervisorFailedError | undefined;

    expect(error).toBeInstanceOf(SupervisorFailedError);
    expect(error?.code).toBe("SUPERVISOR_DISPATCH_CYCLE");
    expect(error?.message).toMatch(/loop → loop/);
  });

  it("detects an indirect cycle (A → B → A)", async () => {
    const sup = supervisor({
      name: "indirect-cycle",
      route: () => "a",
      intents: {
        a: async ctx => {
          await ctx.intents.b.execute();
          return "a-done";
        },
        b: async ctx => {
          await ctx.intents.a.execute();
          return "b-done";
        },
      },
      maxIterations: 1,
    });

    const result = await sup.execute("seed");
    const branch = result.report.snapshots[0]?.result.a;
    const error = branch?.error as SupervisorFailedError | undefined;

    expect(error).toBeInstanceOf(SupervisorFailedError);
    expect(error?.code).toBe("SUPERVISOR_DISPATCH_CYCLE");
    expect(error?.message).toMatch(/a → b → a/);
  });

  it("uses independent stacks per fan-out branch (no false cycle)", async () => {
    const router = buildScriptedAgent({
      name: "router",
      description: "router",
      responses: [
        {
          content: JSON.stringify({ next: ["left", "right"] }),
          finishReason: "stop",
        },
        { content: routerDecision(END), finishReason: "stop" },
      ],
    });

    const sup = supervisor<{ left: string; right: string }>({
      name: "fanout-stacks",
      router,
      intents: {
        left: {
          run: async ctx => ctx.intents.shared.execute(),
          description: "Left-side branch — invokes shared via ctx.intents",
        },
        right: {
          run: async ctx => ctx.intents.shared.execute(),
          description: "Right-side branch — invokes shared via ctx.intents",
        },
        shared: {
          run: async () => "shared-output",
          description: "Common helper invoked by both branches",
        },
      },
    });

    const result = await sup.execute("seed");
    expect(result.error).toBeUndefined();

    expect(result.report.snapshots[0]?.result.left?.output).toBe(
      "shared-output",
    );
    expect(result.report.snapshots[0]?.result.right?.output).toBe(
      "shared-output",
    );
    expect(result.report.snapshots[0]?.result.left?.error).toBeUndefined();
    expect(result.report.snapshots[0]?.result.right?.error).toBeUndefined();
  });

  // NOTE: the previous "rejects byName for an unknown intent" test
  // tested a runtime guard that's no longer reachable via the typed
  // ctx.intents.X.execute API — `ctx.intents` is built from the
  // supervisor's literal intent keys, so unknown keys are caught at
  // compile time. The runtime check inside `runIntent` is kept as
  // defense-in-depth but no longer needs a behavioral test.
});
