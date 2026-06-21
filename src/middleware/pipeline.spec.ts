import { describe, expect, it, vi } from "vitest";
import type {
  AgentMiddleware,
  MiddlewareExecuteContext,
} from "../contracts/middleware";
import { AIError } from "../errors";
import { runPipeline } from "./pipeline";

function makeExecuteContext(): MiddlewareExecuteContext {
  return {
    agent: { name: "test-agent", isAnonymous: false },
    model: { name: "test-model", provider: "test" },
    input: "hi",
    options: undefined,
    state: new Map(),
  };
}

/**
 * Tests validate pipeline mechanics with string results for readability —
 * the real contract types per-level returns (AgentResult, ModelResponse,
 * ToolInvokeResult). Cast the loose-typed test middleware to the strict
 * contract at the pipeline boundary only.
 */
function asMiddleware(value: unknown): AgentMiddleware {
  return value as AgentMiddleware;
}

describe("runPipeline — empty + single middleware", () => {
  it("calls inner directly when no middleware is registered", async () => {
    const context = makeExecuteContext();
    const inner = vi.fn(async () => "ok");

    const result = await runPipeline([], "execute", context, inner);

    expect(result).toBe("ok");
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("skips middleware whose level hooks are not defined", async () => {
    const context = makeExecuteContext();
    const inner = vi.fn(async () => "ok");

    const middleware: AgentMiddleware = {
      name: "trip-only",
      trip: { before: vi.fn() },
    };

    const result = await runPipeline([middleware], "execute", context, inner);

    expect(result).toBe("ok");
    expect(inner).toHaveBeenCalledTimes(1);
    expect(middleware.trip?.before).not.toHaveBeenCalled();
  });

  it("runs before → inner → after for a single middleware", async () => {
    const context = makeExecuteContext();
    const order: string[] = [];

    const middleware = asMiddleware({
      name: "one",
      execute: {
        before: async () => {
          order.push("one.before");
        },
        after: async (_ctx: unknown, result: unknown) => {
          order.push(`one.after(${result})`);
        },
      },
    });

    const result = await runPipeline(
      [middleware],
      "execute",
      context,
      async () => {
        order.push("inner");
        return "value";
      },
    );

    expect(result).toBe("value");
    expect(order).toEqual(["one.before", "inner", "one.after(value)"]);
  });
});

describe("runPipeline — onion ordering", () => {
  it("runs before in registration order and after in reverse", async () => {
    const context = makeExecuteContext();
    const order: string[] = [];

    const make = (name: string) =>
      asMiddleware({
        name,
        execute: {
          before: async () => {
            order.push(`${name}.before`);
          },
          after: async () => {
            order.push(`${name}.after`);
          },
        },
      });

    await runPipeline(
      [make("a"), make("b"), make("c")],
      "execute",
      context,
      async () => {
        order.push("inner");
        return 42;
      },
    );

    expect(order).toEqual([
      "a.before",
      "b.before",
      "c.before",
      "inner",
      "c.after",
      "b.after",
      "a.after",
    ]);
  });

  it("after-hook return value replaces the result for the next outer frame", async () => {
    const context = makeExecuteContext();

    const outer = asMiddleware({
      name: "outer",
      execute: {
        after: async (_ctx: unknown, result: unknown) => `outer(${result})`,
      },
    });

    const inner = asMiddleware({
      name: "inner",
      execute: {
        after: async (_ctx: unknown, result: unknown) => `inner(${result})`,
      },
    });

    const result = await runPipeline(
      [outer, inner],
      "execute",
      context,
      async () => "core",
    );

    expect(result).toBe("outer(inner(core))");
  });
});

describe("runPipeline — short-circuit via before-hook return", () => {
  it("skips inner + deeper befores when a before returns a value", async () => {
    const context = makeExecuteContext();
    const innerFn = vi.fn(async () => "from-inner");
    const deeperBefore = vi.fn();

    const shortCircuiting = asMiddleware({
      name: "short",
      execute: {
        before: async () => "cached",
      },
    });

    const deeper = asMiddleware({
      name: "deeper",
      execute: {
        before: deeperBefore,
      },
    });

    const result = await runPipeline(
      [shortCircuiting, deeper],
      "execute",
      context,
      innerFn,
    );

    expect(result).toBe("cached");
    expect(innerFn).not.toHaveBeenCalled();
    expect(deeperBefore).not.toHaveBeenCalled();
  });

  it("runs outer-middleware after hooks on a short-circuited result", async () => {
    const context = makeExecuteContext();
    const innerFn = vi.fn(async () => "should-not-run");
    const outerAfter = vi.fn(
      async (_ctx: unknown, result: unknown) => `wrapped(${result})`,
    );

    const outer = asMiddleware({
      name: "outer",
      execute: { after: outerAfter },
    });

    const shortCircuiting = asMiddleware({
      name: "cache",
      execute: {
        before: async () => "HIT",
      },
    });

    const result = await runPipeline(
      [outer, shortCircuiting],
      "execute",
      context,
      innerFn,
    );

    expect(result).toBe("wrapped(HIT)");
    expect(outerAfter).toHaveBeenCalledWith(context, "HIT");
    expect(innerFn).not.toHaveBeenCalled();
  });
});

describe("runPipeline — onError recovery", () => {
  it("rethrows when no middleware handles the error", async () => {
    const context = makeExecuteContext();
    const boom = new AIError("AGENT_EXEC_FAILED", "kaboom");

    const middleware = asMiddleware({
      name: "passthrough",
      execute: { before: async () => {} },
    });

    await expect(
      runPipeline([middleware], "execute", context, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it("onError returning a value recovers and flows through outer after hooks", async () => {
    const context = makeExecuteContext();
    const order: string[] = [];

    const outer = asMiddleware({
      name: "outer",
      execute: {
        after: async (_ctx: unknown, result: unknown) => {
          order.push(`outer.after(${result})`);
          return undefined;
        },
      },
    });

    const recoverer = asMiddleware({
      name: "recoverer",
      execute: {
        onError: async (_ctx: unknown, error: unknown) => {
          order.push(`recoverer.onError(${(error as Error).message})`);
          return "RECOVERED";
        },
      },
    });

    const result = await runPipeline(
      [outer, recoverer],
      "execute",
      context,
      async () => {
        order.push("inner-throws");
        throw new AIError("AGENT_EXEC_FAILED", "boom");
      },
    );

    expect(result).toBe("RECOVERED");
    expect(order).toEqual([
      "inner-throws",
      "recoverer.onError(boom)",
      "outer.after(RECOVERED)",
    ]);
  });

  it("onError returning undefined propagates the error to the next outer frame", async () => {
    const context = makeExecuteContext();
    const innerOnError = vi.fn(async () => undefined);
    const outerOnError = vi.fn(async () => "outer-recovered");

    const outer = asMiddleware({
      name: "outer",
      execute: { onError: outerOnError },
    });

    const innerMw = asMiddleware({
      name: "inner-mw",
      execute: { onError: innerOnError },
    });

    const result = await runPipeline(
      [outer, innerMw],
      "execute",
      context,
      async () => {
        throw new AIError("AGENT_EXEC_FAILED", "boom");
      },
    );

    expect(result).toBe("outer-recovered");
    expect(innerOnError).toHaveBeenCalledTimes(1);
    expect(outerOnError).toHaveBeenCalledTimes(1);
  });

  it("errors thrown inside a before hook unwind through outer onError", async () => {
    const context = makeExecuteContext();
    const outerOnError = vi.fn(async (_ctx: unknown, error: unknown) => {
      return `outer-saw(${(error as Error).message})`;
    });

    const outer = asMiddleware({
      name: "outer",
      execute: { onError: outerOnError },
    });

    const thrower = asMiddleware({
      name: "thrower",
      execute: {
        before: async () => {
          throw new AIError("AGENT_EXEC_FAILED", "before-boom");
        },
      },
    });

    const result = await runPipeline(
      [outer, thrower],
      "execute",
      context,
      async () => "never",
    );

    expect(result).toBe("outer-saw(before-boom)");
  });
});

describe("runPipeline — logging", () => {
  it("respects the per-middleware `log: false` kill-switch", async () => {
    const context = makeExecuteContext();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    };

    const loud = asMiddleware({
      name: "loud",
      execute: { before: async () => {}, after: async () => {} },
    });

    const silent = asMiddleware({
      name: "silent",
      log: false,
      execute: { before: async () => {}, after: async () => {} },
    });

    await runPipeline(
      [loud, silent],
      "execute",
      context,
      async () => "done",
      logger as never,
    );

    const debugCalls = logger.debug.mock.calls.map(call => call[2]);

    expect(debugCalls).toContain("loud");
    expect(debugCalls).not.toContain("silent");
  });
});
