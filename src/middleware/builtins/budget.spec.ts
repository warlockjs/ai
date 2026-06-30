import { describe, expect, it, vi } from "vitest";
import { agent } from "../../agent/agent";
import { BudgetExceededError } from "../../errors";
import { MockSDK } from "../../mock/mock-sdk";
import type { BudgetContractViolation } from "./budget";
import { budget, readBudgetFallbackSignal } from "./budget";

function makeAgent(
  responses: Array<{
    content: string;
    finishReason?: "stop" | "tool_calls";
    usage?: { input: number; output: number };
  }>,
  middleware: ReturnType<typeof budget>[],
) {
  const sdk = MockSDK({
    responses: responses.map(response => ({
      content: response.content,
      finishReason: response.finishReason ?? "stop",
      usage: response.usage
        ? {
            ...response.usage,
            total: response.usage.input + response.usage.output,
          }
        : undefined,
    })),
  });

  return agent({
    model: sdk.model({ name: "gpt-test" }),
    middleware,
  });
}

describe("budget — token cap", () => {
  it("allows runs under the token cap", async () => {
    const ai = makeAgent(
      [{ content: "ok", usage: { input: 10, output: 5 } }],
      [budget({ maxTokens: 1000 })],
    );

    const result = await ai.execute("hi");

    expect(result.error).toBeUndefined();
    expect(result.usage.total).toBe(15);
  });

  it("aborts with BudgetExceededError when cumulative tokens exceed the cap", async () => {
    const ai = makeAgent(
      [{ content: "too-big", usage: { input: 100, output: 100 } }],
      [budget({ maxTokens: 60 })],
    );

    const result = await ai.execute("hi");

    expect(result.error).toBeInstanceOf(BudgetExceededError);
    const budgetError = result.error as BudgetExceededError;
    expect(budgetError.unit).toBe("tokens");
    expect(budgetError.limit).toBe(60);
    expect(budgetError.actual).toBe(200);
  });

  it("warn mode does not abort and lets the run complete", async () => {
    const ai = makeAgent(
      [{ content: "over", usage: { input: 100, output: 100 } }],
      [budget({ maxTokens: 10, onExceeded: "warn" })],
    );

    const result = await ai.execute("hi");

    expect(result.error).toBeUndefined();
    expect(result.usage.total).toBe(200);
  });

  it("concurrent executions each track their own budget", async () => {
    const guard = budget({ maxTokens: 50 });
    const sdk = MockSDK({
      responses: [
        { content: "ok", usage: { input: 20, output: 20, total: 40 } },
      ],
    });
    const ai = agent({
      model: sdk.model({ name: "gpt-test" }),
      middleware: [guard],
    });

    const [a, b] = await Promise.all([ai.execute("one"), ai.execute("two")]);

    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
  });
});

describe("budget — USD cap", () => {
  it("aborts when cumulative USD cost exceeds maxCostUSD", async () => {
    const ai = makeAgent(
      [{ content: "spendy", usage: { input: 1000, output: 1000 } }],
      [
        budget({
          maxCostUSD: 0.01,
          pricing: { "gpt-test": { inputPer1K: 0.01, outputPer1K: 0.02 } },
        }),
      ],
    );

    const result = await ai.execute("hi");

    expect(result.error).toBeInstanceOf(BudgetExceededError);
    expect((result.error as BudgetExceededError).unit).toBe("usd");
  });

  it("warns (does not abort) when a USD cap is set but the running model has no pricing entry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ai = makeAgent(
      [{ content: "no pricing", usage: { input: 1000, output: 1000 } }],
      [
        budget({
          maxCostUSD: 0.0001,
          pricing: { "other-model": { inputPer1K: 0.01, outputPer1K: 0.02 } },
        }),
      ],
    );

    const result = await ai.execute("hi");

    // Still degrades (no abort) — but the silent fail-open is now surfaced
    // once, naming the unmatched model, instead of quietly disabling the cap.
    expect(result.error).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("gpt-test");

    warn.mockRestore();
  });
});

describe("budget — SLO contract (abort)", () => {
  it("aborts on the contract token clause with the breached dimension in context", async () => {
    const ai = makeAgent(
      [{ content: "big", usage: { input: 100, output: 100 } }],
      [budget({ contract: { maxTokens: 50 } })],
    );

    const result = await ai.execute("hi");

    expect(result.error).toBeInstanceOf(BudgetExceededError);
    const budgetError = result.error as BudgetExceededError;
    expect(budgetError.unit).toBe("tokens");
    expect(budgetError.context).toMatchObject({
      dimension: "tokens",
      source: "contract",
      limit: 50,
      actual: 200,
    });
  });

  it("aborts on the contract cost clause when cumulative USD exceeds maxCostUSD", async () => {
    const ai = makeAgent(
      [{ content: "spendy", usage: { input: 1000, output: 1000 } }],
      [
        budget({
          pricing: { "gpt-test": { inputPer1K: 0.01, outputPer1K: 0.02 } },
          contract: { maxCostUSD: 0.01 },
        }),
      ],
    );

    const result = await ai.execute("hi");

    expect(result.error).toBeInstanceOf(BudgetExceededError);
    const budgetError = result.error as BudgetExceededError;
    expect(budgetError.unit).toBe("usd");
    expect(budgetError.context).toMatchObject({ dimension: "cost" });
  });

  it("aborts on the contract latency clause once wall-clock exceeds maxLatencyMs", async () => {
    const sdk = MockSDK({
      responses: [
        { content: "slow", usage: { input: 1, output: 1, total: 2 }, delay: 30 },
      ],
    });
    const ai = agent({
      model: sdk.model({ name: "gpt-test" }),
      middleware: [budget({ contract: { maxLatencyMs: 5 } })],
    });

    const result = await ai.execute("hi");

    expect(result.error).toBeInstanceOf(BudgetExceededError);
    const budgetError = result.error as BudgetExceededError;
    expect(budgetError.context).toMatchObject({ dimension: "latency" });
    expect((budgetError.context as { actual: number }).actual).toBeGreaterThan(
      5,
    );
  });

  it("contract clauses do not fire when the run stays within the SLO", async () => {
    const ai = makeAgent(
      [{ content: "ok", usage: { input: 5, output: 5 } }],
      [
        budget({
          pricing: { "gpt-test": { inputPer1K: 0.01, outputPer1K: 0.02 } },
          contract: { maxTokens: 1000, maxCostUSD: 1, maxLatencyMs: 60_000 },
        }),
      ],
    );

    const result = await ai.execute("hi");

    expect(result.error).toBeUndefined();
  });
});

describe("budget — SLO contract (fallback)", () => {
  it("does not abort, fires the fallback callback, and records the signal", async () => {
    const fallback = vi.fn();
    let recorded: BudgetContractViolation | undefined;

    const sdk = MockSDK({
      responses: [{ content: "big", usage: { input: 100, output: 100, total: 200 } }],
    });
    const ai = agent({
      model: sdk.model({ name: "gpt-test" }),
      middleware: [
        budget({
          contract: { maxTokens: 50, onViolation: "fallback", fallback },
        }),
        {
          name: "probe",
          execute: {
            after(context) {
              recorded = readBudgetFallbackSignal(context.state);
            },
          },
        },
      ],
    });

    const result = await ai.execute("hi");

    expect(result.error).toBeUndefined();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback.mock.calls[0][0]).toMatchObject({
      dimension: "tokens",
      mode: "fallback",
      limit: 50,
      actual: 200,
    });
    expect(recorded).toMatchObject({ dimension: "tokens", mode: "fallback" });
  });

  it("fires the fallback callback at most once even when several clauses breach", async () => {
    const fallback = vi.fn();
    const ai = makeAgent(
      [{ content: "big", usage: { input: 1000, output: 1000 } }],
      [
        budget({
          pricing: { "gpt-test": { inputPer1K: 0.01, outputPer1K: 0.02 } },
          contract: {
            maxTokens: 50,
            maxCostUSD: 0.001,
            onViolation: "fallback",
            fallback,
          },
        }),
      ],
    );

    const result = await ai.execute("hi");

    expect(result.error).toBeUndefined();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback.mock.calls[0][0]).toMatchObject({ dimension: "tokens" });
  });

  it("swallows a throwing fallback callback so the run still completes", async () => {
    const ai = makeAgent(
      [{ content: "big", usage: { input: 100, output: 100 } }],
      [
        budget({
          contract: {
            maxTokens: 50,
            onViolation: "fallback",
            fallback: () => {
              throw new Error("boom");
            },
          },
        }),
      ],
    );

    const result = await ai.execute("hi");

    expect(result.error).toBeUndefined();
  });

  it("readBudgetFallbackSignal returns undefined when no contract clause tripped", async () => {
    let recorded: BudgetContractViolation | undefined = {
      dimension: "tokens",
      limit: 0,
      actual: 0,
      mode: "fallback",
    };

    const sdk = MockSDK({
      responses: [{ content: "ok", usage: { input: 5, output: 5, total: 10 } }],
    });
    const ai = agent({
      model: sdk.model({ name: "gpt-test" }),
      middleware: [
        budget({ contract: { maxTokens: 1000, onViolation: "fallback" } }),
        {
          name: "probe",
          execute: {
            after(context) {
              recorded = readBudgetFallbackSignal(context.state);
            },
          },
        },
      ],
    });

    await ai.execute("hi");

    expect(recorded).toBeUndefined();
  });
});
