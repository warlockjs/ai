import { describe, expect, it } from "vitest";
import type { AgentMiddleware } from "../contracts/middleware/middleware.contract";
import type { SupervisorResult } from "../contracts/result/supervisor-result.type";
import { END } from "../contracts/end.type";
import { AIError } from "../errors/ai-error";
import { buildScriptedAgent } from "./_test-helpers";
import { supervisor } from "./supervisor";

/**
 * Tests for the `supervisor`-level middleware (SHARED S3) — the
 * optional `supervisor` hook map on `AgentMiddleware`, fired once
 * around the whole `supervisor.execute()` run, mirroring the agent's
 * `execute`-level pipeline.
 */

function buildNoopSupervisor(middleware: AgentMiddleware[]) {
  const noop = buildScriptedAgent({
    name: "noop",
    description: "noop",
    responses: [{ content: "ok", finishReason: "stop" }],
  });

  return supervisor({
    name: "mw-sup",
    intents: { noop },
    route: (ctx) => (ctx.iteration === 0 ? "noop" : END),
    middleware,
  });
}

describe("supervisor — supervisor-level middleware", () => {
  it("fires before then after around the run with the final result", async () => {
    const calls: string[] = [];

    const middleware: AgentMiddleware = {
      name: "trace",
      supervisor: {
        before(ctx) {
          calls.push(`before:${ctx.supervisor.name}`);
        },
        after(_ctx, result) {
          calls.push(`after:${result.type}`);
        },
      },
    };

    const sup = buildNoopSupervisor([middleware]);

    const result = await sup.execute("hi");

    expect(result.error).toBeUndefined();
    expect(calls).toEqual(["before:mw-sup", "after:supervisor"]);
  });

  it("short-circuits the run when before returns a synthetic result", async () => {
    let dispatched = false;

    const noop = buildScriptedAgent({
      name: "noop",
      description: "noop",
      responses: [{ content: "ok", finishReason: "stop" }],
    });

    const synthetic: SupervisorResult<unknown> = {
      type: "supervisor",
      data: { cached: true },
      usage: { input: 0, output: 0, total: 0 },
      report: {
        runId: "synthetic",
        rootRunId: "synthetic",
        name: "mw-sup",
        type: "supervisor",
        supervisorName: "mw-sup",
        signature: "synthetic",
        status: "completed",
        terminatedBy: "route",
        iterations: 0,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        duration: 0,
        usage: { input: 0, output: 0, total: 0 },
        children: [],
        snapshots: [],
      },
    };

    const middleware: AgentMiddleware = {
      name: "run-cache",
      supervisor: {
        before() {
          return synthetic;
        },
      },
    };

    const sup = supervisor({
      name: "mw-sup",
      intents: { noop },
      route: (ctx) => {
        dispatched = true;
        return ctx.iteration === 0 ? "noop" : END;
      },
      middleware: [middleware],
    });

    const result = await sup.execute("hi");

    expect(dispatched).toBe(false);
    expect(result.data).toEqual({ cached: true });
  });

  it("aborts the whole run when before throws", async () => {
    let dispatched = false;

    const noop = buildScriptedAgent({
      name: "noop",
      description: "noop",
      responses: [{ content: "ok", finishReason: "stop" }],
    });

    const middleware: AgentMiddleware = {
      name: "deny",
      supervisor: {
        before() {
          throw new AIError("SUPERVISOR_FAILED", "denied");
        },
      },
    };

    const sup = supervisor({
      name: "mw-sup",
      intents: { noop },
      route: (ctx) => {
        dispatched = true;
        return ctx.iteration === 0 ? "noop" : END;
      },
      middleware: [middleware],
    });

    const result = await sup.execute("hi");

    expect(dispatched).toBe(false);
    expect(result.error).toBeInstanceOf(AIError);
    expect(result.error?.message).toBe("denied");
  });

  it("lets after replace the final result", async () => {
    const replacement = { data: "replaced" };

    const middleware: AgentMiddleware = {
      name: "rewrite",
      supervisor: {
        after(_ctx, result) {
          return { ...result, data: replacement };
        },
      },
    };

    const sup = buildNoopSupervisor([middleware]);

    const result = await sup.execute("hi");

    expect(result.data).toEqual(replacement);
  });

  it("recovers a thrown run when onError returns a result", async () => {
    const noop = buildScriptedAgent({
      name: "noop",
      description: "noop",
      responses: [{ content: "ok", finishReason: "stop" }],
    });

    const recovered: SupervisorResult<unknown> = {
      type: "supervisor",
      data: { recovered: true },
      usage: { input: 0, output: 0, total: 0 },
      report: {
        runId: "recovered",
        rootRunId: "recovered",
        name: "mw-sup",
        type: "supervisor",
        supervisorName: "mw-sup",
        signature: "recovered",
        status: "completed",
        terminatedBy: "route",
        iterations: 0,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        duration: 0,
        usage: { input: 0, output: 0, total: 0 },
        children: [],
        snapshots: [],
      },
    };

    const thrower: AgentMiddleware = {
      name: "thrower",
      supervisor: {
        before() {
          throw new AIError("SUPERVISOR_FAILED", "boom");
        },
      },
    };

    const rescuer: AgentMiddleware = {
      name: "rescuer",
      supervisor: {
        onError() {
          return recovered;
        },
      },
    };

    const sup = supervisor({
      name: "mw-sup",
      intents: { noop },
      route: (ctx) => (ctx.iteration === 0 ? "noop" : END),
      middleware: [rescuer, thrower],
    });

    const result = await sup.execute("hi");

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ recovered: true });
  });

  it("threads a fresh state bag through before and after of the same run", async () => {
    let seenInAfter: unknown;

    const middleware: AgentMiddleware = {
      name: "stateful",
      supervisor: {
        before(ctx) {
          ctx.state.set("stateful.token", "abc");
        },
        after(ctx) {
          seenInAfter = ctx.state.get("stateful.token");
        },
      },
    };

    const sup = buildNoopSupervisor([middleware]);

    await sup.execute("hi");

    expect(seenInAfter).toBe("abc");
  });

  it("runs before top-down and after bottom-up (onion order)", async () => {
    const order: string[] = [];

    const outer: AgentMiddleware = {
      name: "outer",
      supervisor: {
        before() {
          order.push("outer.before");
        },
        after() {
          order.push("outer.after");
        },
      },
    };

    const inner: AgentMiddleware = {
      name: "inner",
      supervisor: {
        before() {
          order.push("inner.before");
        },
        after() {
          order.push("inner.after");
        },
      },
    };

    const sup = buildNoopSupervisor([outer, inner]);

    await sup.execute("hi");

    expect(order).toEqual([
      "outer.before",
      "inner.before",
      "inner.after",
      "outer.after",
    ]);
  });

  it("skips middleware that declares no supervisor hook map", async () => {
    let executeFired = false;

    const agentOnly: AgentMiddleware = {
      name: "agent-only",
      execute: {
        before() {
          executeFired = true;
        },
      },
    };

    const sup = buildNoopSupervisor([agentOnly]);

    const result = await sup.execute("hi");

    expect(result.error).toBeUndefined();
    expect(executeFired).toBe(false);
  });

  it("surfaces the run input and options on the supervisor context", async () => {
    let seenInput: unknown;
    let seenSignalPresent = false;

    const middleware: AgentMiddleware = {
      name: "ctx-probe",
      supervisor: {
        before(ctx) {
          seenInput = ctx.input;
          seenSignalPresent = ctx.signal !== undefined;
        },
      },
    };

    const sup = buildNoopSupervisor([middleware]);
    const controller = new AbortController();

    await sup.execute("hello supervisor", { signal: controller.signal });

    expect(seenInput).toBe("hello supervisor");
    expect(seenSignalPresent).toBe(true);
  });
});
