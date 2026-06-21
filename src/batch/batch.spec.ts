import { describe, expect, it, vi } from "vitest";
import type { BaseReport } from "../contracts/result/base-report.type";
import type { ExecutableContract } from "../contracts/executable.contract";
import type { ExecuteResult } from "../contracts/result/execute-result.type";
import type { Usage } from "../contracts/result/usage.type";
import { AIError } from "../errors/ai-error";
import { batch } from "./batch";

type FakeInput = { id: number };

type FakeBehavior = {
  /** Throw with this message instead of returning. */
  throws?: string;
  /** Return a result whose `.error` is set (soft failure). */
  softError?: string;
  /** Token usage to report. Defaults to a trivial 10/20/30. */
  usage?: Usage;
  /** Output payload for `result.data`. */
  data?: unknown;
  /** Artificial delay in ms before settling. */
  delayMs?: number;
};

function makeReport(name: string, usage: Usage): BaseReport {
  return {
    runId: `agent_${name}`,
    rootRunId: `agent_${name}`,
    name,
    type: "agent",
    status: "completed",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    duration: 1,
    usage,
    children: [],
  };
}

/**
 * A controllable fake executable. `behaviorFor(input)` decides what
 * each call does — lets a single instance succeed for some items and
 * fail for others, and (with a counter) succeed only after N retries.
 */
function fakeExecutable(
  behaviorFor: (input: FakeInput, callCount: number) => FakeBehavior,
): ExecutableContract<FakeInput, { signal?: AbortSignal }, ExecuteResult> & {
  calls: number;
} {
  const callsByItem = new Map<number, number>();

  return {
    calls: 0,
    async execute(input, options) {
      this.calls += 1;
      const previous = callsByItem.get(input.id) ?? 0;
      const callCount = previous + 1;
      callsByItem.set(input.id, callCount);

      const behavior = behaviorFor(input, callCount);

      if (behavior.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
      }

      if (options?.signal?.aborted) {
        const abortError = new Error("aborted");
        abortError.name = "AbortError";
        throw abortError;
      }

      if (behavior.throws) {
        throw new Error(behavior.throws);
      }

      const usage = behavior.usage ?? { input: 10, output: 20, total: 30 };

      const result: ExecuteResult = {
        data: behavior.data ?? `done-${input.id}`,
        usage,
        report: makeReport(`item-${input.id}`, usage),
      };

      if (behavior.softError) {
        result.error = new AIError("WORKFLOW_ERROR", behavior.softError);
      }

      return result;
    },
  };
}

const items: FakeInput[] = [{ id: 1 }, { id: 2 }, { id: 3 }];

describe("batch", () => {
  it("runs the executable once per item and returns ordered per-item results", async () => {
    const executable = fakeExecutable(() => ({}));

    const result = await batch(executable, items);

    expect(executable.calls).toBe(3);
    expect(result.items).toHaveLength(3);
    expect(result.items.map((item) => item.index)).toEqual([0, 1, 2]);
    expect(result.items.every((item) => item.status === "completed")).toBe(true);
  });

  it("exposes the unified result envelope shape", async () => {
    const executable = fakeExecutable(() => ({}));

    const result = await batch(executable, items);

    expect(result.type).toBe("batch");
    expect(result.report.type).toBe("batch");
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.data)).toBe(true);
  });

  it("rolls up usage across every item", async () => {
    const executable = fakeExecutable(() => ({ usage: { input: 5, output: 7, total: 12 } }));

    const result = await batch(executable, items);

    expect(result.usage).toEqual({ input: 15, output: 21, total: 36 });
    expect(result.report.usage).toEqual({ input: 15, output: 21, total: 36 });
  });

  it("accumulates optional usage sub-channels only when reported", async () => {
    const executable = fakeExecutable((input) => ({
      usage:
        input.id === 1
          ? { input: 10, output: 5, total: 15, cachedTokens: 4, reasoningTokens: 3 }
          : { input: 10, output: 5, total: 15 },
    }));

    const result = await batch(executable, items);

    expect(result.usage.cachedTokens).toBe(4);
    expect(result.usage.reasoningTokens).toBe(3);
    expect(result.usage.cacheWriteTokens).toBeUndefined();
  });

  it("attaches each item's report as a child of the batch report", async () => {
    const executable = fakeExecutable(() => ({}));

    const result = await batch(executable, items);

    expect(result.report.children).toHaveLength(3);
    expect(result.report.total).toBe(3);
    expect(result.report.succeeded).toBe(3);
    expect(result.report.failed).toBe(0);
  });

  it("stamps the batch run id as rootRunId on every child report", async () => {
    const executable = fakeExecutable(() => ({}));

    const result = await batch(executable, items, { sessionId: "session-x" });

    const rootRunId = result.report.runId;
    expect(result.report.children.every((child) => child.rootRunId === rootRunId)).toBe(true);
    expect(result.report.children.every((child) => child.parentRunId === rootRunId)).toBe(true);
    expect(result.report.children.every((child) => child.sessionId === "session-x")).toBe(true);
  });

  it("fills data positionally with output for completed items", async () => {
    const executable = fakeExecutable((input) => ({ data: `out-${input.id}` }));

    const result = await batch(executable, items);

    expect(result.data).toEqual(["out-1", "out-2", "out-3"]);
  });
});

describe("batch failure handling", () => {
  it("isolates a thrown failure without rejecting the batch", async () => {
    const executable = fakeExecutable((input) =>
      input.id === 2 ? { throws: "boom" } : {},
    );

    const result = await batch(executable, items);

    expect(result.items[1].status).toBe("failed");
    expect(result.items[1].error).toBeInstanceOf(AIError);
    expect(result.items[0].status).toBe("completed");
    expect(result.items[2].status).toBe("completed");
    expect(result.report.failed).toBe(1);
    expect(result.report.status).toBe("failed");
  });

  it("treats a result-level error as a failed item", async () => {
    const executable = fakeExecutable((input) =>
      input.id === 3 ? { softError: "soft fail" } : {},
    );

    const result = await batch(executable, items);

    expect(result.items[2].status).toBe("failed");
    expect(result.items[2].error?.message).toBe("soft fail");
    expect(result.data[2]).toBeUndefined();
  });

  it("does not include a failed item's output in the data array", async () => {
    const executable = fakeExecutable((input) =>
      input.id === 1 ? { throws: "x" } : { data: `ok-${input.id}` },
    );

    const result = await batch(executable, items);

    expect(result.data[0]).toBeUndefined();
    expect(result.data[1]).toBe("ok-2");
  });
});

describe("batch retry", () => {
  it("retries a failing item up to the configured attempts and succeeds", async () => {
    const executable = fakeExecutable((input, callCount) =>
      input.id === 2 && callCount < 3 ? { throws: "transient" } : {},
    );

    const result = await batch(executable, items, {
      retry: { attempts: 3, backoff: "none" },
    });

    expect(result.items[1].status).toBe("completed");
    expect(result.items[1].attempts).toBe(3);
    expect(result.report.succeeded).toBe(3);
  });

  it("reports failed after exhausting all attempts", async () => {
    const executable = fakeExecutable((input) =>
      input.id === 2 ? { throws: "always" } : {},
    );

    const result = await batch(executable, items, {
      retry: { attempts: 2, backoff: "none" },
    });

    expect(result.items[1].status).toBe("failed");
    expect(result.items[1].attempts).toBe(2);
  });

  it("honors retryOn to stop retrying early", async () => {
    const retryOn = vi.fn().mockReturnValue(false);
    const executable = fakeExecutable((input) =>
      input.id === 1 ? { throws: "fatal" } : {},
    );

    const result = await batch(executable, items, {
      retry: { attempts: 5, backoff: "none", retryOn },
    });

    expect(result.items[0].attempts).toBe(1);
    expect(retryOn).toHaveBeenCalledTimes(1);
  });

  it("fires onRetry before each retry", async () => {
    const onRetry = vi.fn();
    const executable = fakeExecutable((input, callCount) =>
      input.id === 1 && callCount < 2 ? { throws: "once" } : {},
    );

    await batch(executable, items, {
      retry: { attempts: 3, backoff: "none", onRetry },
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(2, expect.any(Error));
  });
});

describe("batch concurrency", () => {
  it("never exceeds the configured concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;

    const executable: ExecutableContract<FakeInput, { signal?: AbortSignal }, ExecuteResult> = {
      async execute(input) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;

        const usage: Usage = { input: 1, output: 1, total: 2 };
        return { data: input.id, usage, report: makeReport(`i-${input.id}`, usage) };
      },
    };

    const many = Array.from({ length: 10 }, (_unused, id) => ({ id }));
    const result = await batch(executable, many, { concurrency: 3 });

    expect(peak).toBeLessThanOrEqual(3);
    expect(result.items).toHaveLength(10);
    expect(result.report.succeeded).toBe(10);
  });

  it("runs serially when concurrency is 1", async () => {
    let inFlight = 0;
    let peak = 0;

    const executable: ExecutableContract<FakeInput, { signal?: AbortSignal }, ExecuteResult> = {
      async execute(input) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;

        const usage: Usage = { input: 1, output: 1, total: 2 };
        return { data: input.id, usage, report: makeReport(`i-${input.id}`, usage) };
      },
    };

    await batch(executable, items, { concurrency: 1 });

    expect(peak).toBe(1);
  });
});

describe("batch cancellation", () => {
  it("marks not-yet-started items as cancelled when aborted up front", async () => {
    const controller = new AbortController();
    controller.abort();

    const executable = fakeExecutable(() => ({}));

    const result = await batch(executable, items, { signal: controller.signal });

    expect(result.items.every((item) => item.status === "cancelled")).toBe(true);
    expect(result.report.cancelled).toBe(3);
    expect(executable.calls).toBe(0);
  });

  it("stops dispatching remaining items once aborted mid-run", async () => {
    const controller = new AbortController();

    const executable = fakeExecutable((input) => {
      if (input.id === 1) {
        controller.abort();
      }

      return { delayMs: 5 };
    });

    const many = Array.from({ length: 6 }, (_unused, id) => ({ id }));
    const result = await batch(executable, many, {
      concurrency: 1,
      signal: controller.signal,
    });

    const cancelled = result.items.filter((item) => item.status === "cancelled");
    expect(cancelled.length).toBeGreaterThan(0);
  });
});

describe("batch onItem hook", () => {
  it("fires once per item after it settles", async () => {
    const seen: number[] = [];
    const executable = fakeExecutable(() => ({}));

    await batch(executable, items, {
      onItem: (item) => {
        seen.push(item.index);
      },
    });

    expect(seen.sort()).toEqual([0, 1, 2]);
  });

  it("swallows a throw from onItem without breaking the batch", async () => {
    const executable = fakeExecutable(() => ({}));

    const result = await batch(executable, items, {
      onItem: () => {
        throw new Error("hook blew up");
      },
    });

    expect(result.report.succeeded).toBe(3);
  });
});

describe("batch edge cases", () => {
  it("handles an empty item list", async () => {
    const executable = fakeExecutable(() => ({}));

    const result = await batch(executable, []);

    expect(result.items).toHaveLength(0);
    expect(result.report.total).toBe(0);
    expect(result.report.status).toBe("completed");
    expect(result.usage).toEqual({ input: 0, output: 0, total: 0 });
  });
});
