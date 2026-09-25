import { describe, expect, it, vi } from "vitest";
import { agent } from "../../agent/agent";
import { BudgetExceededError } from "../../errors";
import { MockSDK } from "../../mock/mock-sdk";
import { MemoryCacheDriver, cache } from "@warlock.js/cache";
import type { BudgetContractViolation } from "./budget";
import {
  budget,
  cacheScopedBudgetStore,
  memoryScopedBudgetStore,
  readBudgetFallbackSignal,
} from "./budget";

function makeAgent(
  responses: Array<{
    content: string;
    finishReason?: "stop" | "tool_calls";
    usage?: { input: number; output: number };
  }>,
  middleware: ReturnType<typeof budget>[],
) {
  const sdk = MockSDK({
    responses: responses.map((response) => ({
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

  const model = sdk.model({ name: "gpt-test" });
  return Object.assign(agent({ model, middleware }), { model });
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
      responses: [{ content: "ok", usage: { input: 20, output: 20, total: 40 } }],
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

  it("rejects an unpriced model before its first call and names the opt-out", async () => {
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

    expect(result.error).toBeInstanceOf(BudgetExceededError);
    expect(result.error?.message).toContain('"gpt-test"');
    expect(result.error?.message).toContain('onUnpriced: "allow"');
    expect(ai.model.callCount).toBe(0);
  });

  it("allows an unpriced model only when explicitly opted out", async () => {
    const ai = makeAgent(
      [{ content: "no pricing", usage: { input: 1000, output: 1000 } }],
      [budget({ maxCostUSD: 0.0001, onUnpriced: "allow" })],
    );

    const result = await ai.execute("hi");

    expect(result.error).toBeUndefined();
    expect(ai.model.callCount).toBe(1);
  });

  it("uses model-level ModelPricing when the budget has no matching price entry", async () => {
    const sdk = MockSDK({
      responses: [{ content: "spendy", usage: { input: 1000, output: 1000, total: 2000 } }],
    });
    const ai = agent({
      model: sdk.model({ name: "gpt-test", pricing: { input: 10, output: 20 } }),
      middleware: [budget({ maxCostUSD: 0.01 })],
    });

    const result = await ai.execute("hi");

    expect(result.error).toBeInstanceOf(BudgetExceededError);
    expect((result.error as BudgetExceededError).unit).toBe("usd");
  });

  it("uses SDK-resolved ModelPricing when the budget has no matching price entry", async () => {
    const sdk = MockSDK({
      pricing: { input: 10, output: 20 },
      responses: [{ content: "spendy", usage: { input: 1000, output: 1000, total: 2000 } }],
    });
    const ai = agent({
      model: sdk.model({ name: "gpt-test" }),
      middleware: [budget({ maxCostUSD: 0.01 })],
    });

    const result = await ai.execute("hi");

    expect(result.error).toBeInstanceOf(BudgetExceededError);
  });

  it("keeps explicit budget pricing ahead of model pricing", async () => {
    const sdk = MockSDK({
      responses: [{ content: "spendy", usage: { input: 1000, output: 1000, total: 2000 } }],
    });
    const ai = agent({
      model: sdk.model({ name: "gpt-test", pricing: { input: 0.001, output: 0.001 } }),
      middleware: [
        budget({
          maxCostUSD: 0.01,
          pricing: { "gpt-test": { inputPer1K: 0.01, outputPer1K: 0.02 } },
        }),
      ],
    });

    const result = await ai.execute("hi");

    expect(result.error).toBeInstanceOf(BudgetExceededError);
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
      responses: [{ content: "slow", usage: { input: 1, output: 1, total: 2 }, delay: 30 }],
    });
    const ai = agent({
      model: sdk.model({ name: "gpt-test" }),
      middleware: [budget({ contract: { maxLatencyMs: 5 } })],
    });

    const result = await ai.execute("hi");

    expect(result.error).toBeInstanceOf(BudgetExceededError);
    const budgetError = result.error as BudgetExceededError;
    expect(budgetError.context).toMatchObject({ dimension: "latency" });
    expect((budgetError.context as { actual: number }).actual).toBeGreaterThan(5);
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

describe("budget — scoped ledgers", () => {
  it("rejects a second execution when its scoped token window is exhausted", async () => {
    const store = memoryScopedBudgetStore();
    const ai = makeAgent(
      [
        { content: "first", usage: { input: 5, output: 5 } },
        { content: "second", usage: { input: 5, output: 5 } },
      ],
      [budget({ scoped: { key: "user.42", window: "day", maxTokens: 10, store } })],
    );

    const first = await ai.execute("first");
    const second = await ai.execute("second");

    expect(first.error).toBeUndefined();
    expect(second.error).toMatchObject({
      name: "ScopedBudgetExceededError",
      key: "user.42",
      window: "day",
      limit: 10,
      used: 20,
    });
  });

  it("starts a fresh ledger at the next UTC day", async () => {
    const store = memoryScopedBudgetStore();
    const first = await store.reserve({
      key: "tenant.7",
      windowStart: Date.UTC(2026, 8, 17),
      unit: "tokens",
      amount: 10,
      limit: 10,
    });
    const nextDay = await store.reserve({
      key: "tenant.7",
      windowStart: Date.UTC(2026, 8, 18),
      unit: "tokens",
      amount: 10,
      limit: 10,
    });

    expect(first).toEqual({ allowed: true, used: 10 });
    expect(nextDay).toEqual({ allowed: true, used: 10 });
  });

  it("never allows more than ten concurrent memory reservations", async () => {
    const store = memoryScopedBudgetStore();
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        store.reserve({
          key: "user.concurrent",
          windowStart: Date.UTC(2026, 8, 17),
          unit: "tokens",
          amount: 1,
          limit: 10,
        }),
      ),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(10);
  });

  it("never allows more than ten concurrent cache-memory reservations", async () => {
    cache.setCacheConfigurations({
      default: "memory",
      drivers: { memory: MemoryCacheDriver },
      options: { memory: {} },
    });
    await cache.init();
    const store = await cacheScopedBudgetStore();
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        store.reserve({
          key: "user.cached",
          windowStart: Date.UTC(2026, 8, 17),
          unit: "tokens",
          amount: 1,
          limit: 10,
        }),
      ),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(10);
    await cache.flush();
    await cache.disconnect();
  });
});
