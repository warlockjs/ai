import { describe, expect, it, vi } from "vitest";
import type {
  AgentMiddleware,
  MiddlewareSupervisorContext,
} from "../contracts/middleware";
import { AIError } from "../errors";
import { runPipeline } from "./pipeline";

/**
 * Tests for the `supervisor` middleware level on `runPipeline` — proves
 * the generic pipeline drives the new level with the supervisor context
 * shape, independent of the supervisor engine wiring. Result values are
 * plain strings for readability; the real engine threads a
 * `SupervisorResult`.
 */

function makeSupervisorContext(): MiddlewareSupervisorContext {
  return {
    supervisor: { name: "test-sup", signature: "sig-1" },
    input: "hi",
    options: undefined,
    state: new Map(),
  };
}

function asMiddleware(value: unknown): AgentMiddleware {
  return value as AgentMiddleware;
}

describe("runPipeline — supervisor level", () => {
  it("runs before → inner → after for a supervisor-level middleware", async () => {
    const context = makeSupervisorContext();
    const order: string[] = [];

    const middleware = asMiddleware({
      name: "sup-trace",
      supervisor: {
        before: async () => {
          order.push("before");
        },
        after: async (_ctx: unknown, result: unknown) => {
          order.push(`after(${result})`);
        },
      },
    });

    const result = await runPipeline(
      [middleware],
      "supervisor",
      context,
      async () => "core",
    );

    expect(result).toBe("core");
    expect(order).toEqual(["before", "after(core)"]);
  });

  it("short-circuits inner when before returns a value", async () => {
    const context = makeSupervisorContext();
    const inner = vi.fn(async () => "core");

    const middleware = asMiddleware({
      name: "sup-cache",
      supervisor: {
        before: async () => "cached",
      },
    });

    const result = await runPipeline([middleware], "supervisor", context, inner);

    expect(result).toBe("cached");
    expect(inner).not.toHaveBeenCalled();
  });

  it("recovers via onError when inner throws", async () => {
    const context = makeSupervisorContext();

    const middleware = asMiddleware({
      name: "sup-rescue",
      supervisor: {
        onError: async () => "recovered",
      },
    });

    const result = await runPipeline(
      [middleware],
      "supervisor",
      context,
      async () => {
        throw new AIError("SUPERVISOR_FAILED", "boom");
      },
    );

    expect(result).toBe("recovered");
  });

  it("skips middleware that declares no supervisor hook map", async () => {
    const context = makeSupervisorContext();
    const inner = vi.fn(async () => "core");

    const middleware: AgentMiddleware = {
      name: "execute-only",
      execute: { before: vi.fn() },
    };

    const result = await runPipeline([middleware], "supervisor", context, inner);

    expect(result).toBe("core");
    expect(inner).toHaveBeenCalledTimes(1);
    expect(middleware.execute?.before).not.toHaveBeenCalled();
  });
});
