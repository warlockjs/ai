import { describe, expect, it } from "vitest";
import type { Message } from "../contracts/conversation-message.type";
import type {
  ModelContract,
  ModelResponse,
  ModelStreamChunk,
} from "../contracts/model.contract";
import { AIError } from "../errors/ai-error";
import { InvalidRequestError } from "../errors/invalid-request-error";
import { ProviderAuthError } from "../errors/provider-auth-error";
import { ProviderError } from "../errors/provider-error";
import { ProviderRateLimitError } from "../errors/provider-rate-limit-error";
import { ProviderTimeoutError } from "../errors/provider-timeout-error";
import { MockModel } from "../mock/mock-model";
import { fallbackModel } from "./fallback-model";

const userMessage: Message[] = [{ role: "user", content: "hi" }];

/** A MockModel scripted to always throw the given error on complete/stream. */
function failingModel(name: string, error: Error): MockModel {
  return new MockModel(name, [{ content: "", error }]);
}

/** A MockModel scripted to return a single successful response. */
function okModel(name: string, content = "ok"): MockModel {
  return new MockModel(name, [{ content, finishReason: "stop" }]);
}

/** Drain an async iterable of stream chunks into an array. */
async function collect(
  stream: AsyncIterable<ModelStreamChunk>,
): Promise<ModelStreamChunk[]> {
  const chunks: ModelStreamChunk[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return chunks;
}

describe("fallbackModel — construction", () => {
  it("throws when given an empty chain", () => {
    expect(() => fallbackModel([])).toThrowError(AIError);
  });

  it("fronts the identity, capabilities, and pricing of the primary model", () => {
    const primary = new MockModel("primary", [{ content: "x" }], {
      vision: true,
    });
    const backup = okModel("backup");

    const model = fallbackModel([primary, backup]);

    expect(model.name).toBe("primary");
    expect(model.provider).toBe("mock");
    expect(model.capabilities).toEqual({ vision: true });
  });

  it("returns a ModelContract usable as a single model", () => {
    const model: ModelContract = fallbackModel([okModel("only")]);

    expect(typeof model.complete).toBe("function");
    expect(typeof model.stream).toBe("function");
  });
});

describe("fallbackModel.complete — happy path", () => {
  it("uses the primary model when it succeeds and never touches the backup", async () => {
    const primary = okModel("primary", "from-primary");
    const backup = okModel("backup", "from-backup");

    const model = fallbackModel([primary, backup]);
    const response = await model.complete(userMessage);

    expect(response.content).toBe("from-primary");
    expect(primary.callCount).toBe(1);
    expect(backup.callCount).toBe(0);
  });
});

describe("fallbackModel.complete — fall-over on transient errors", () => {
  it("advances on a rate-limit error and returns the backup's response", async () => {
    const primary = failingModel(
      "primary",
      new ProviderRateLimitError("429"),
    );
    const backup = okModel("backup", "recovered");

    const model = fallbackModel([primary, backup]);
    const response = await model.complete(userMessage);

    expect(response.content).toBe("recovered");
    expect(primary.callCount).toBe(1);
    expect(backup.callCount).toBe(1);
  });

  it("advances on a timeout error", async () => {
    const primary = failingModel("primary", new ProviderTimeoutError("slow"));
    const backup = okModel("backup", "recovered");

    const response = await fallbackModel([primary, backup]).complete(
      userMessage,
    );

    expect(response.content).toBe("recovered");
  });

  it("advances on a generic provider (5xx) error", async () => {
    const primary = failingModel("primary", new ProviderError("502 bad gateway"));
    const backup = okModel("backup", "recovered");

    const response = await fallbackModel([primary, backup]).complete(
      userMessage,
    );

    expect(response.content).toBe("recovered");
  });

  it("walks the whole chain, stopping at the first model that succeeds", async () => {
    const first = failingModel("first", new ProviderTimeoutError("t"));
    const second = failingModel("second", new ProviderRateLimitError("r"));
    const third = okModel("third", "third-wins");

    const model = fallbackModel([first, second, third]);
    const response = await model.complete(userMessage);

    expect(response.content).toBe("third-wins");
    expect(first.callCount).toBe(1);
    expect(second.callCount).toBe(1);
    expect(third.callCount).toBe(1);
  });
});

describe("fallbackModel.complete — non-retryable errors propagate", () => {
  it("re-throws an auth error without trying the backup", async () => {
    const primary = failingModel("primary", new ProviderAuthError("bad key"));
    const backup = okModel("backup");

    const model = fallbackModel([primary, backup]);

    await expect(model.complete(userMessage)).rejects.toBeInstanceOf(
      ProviderAuthError,
    );
    expect(backup.callCount).toBe(0);
  });

  it("re-throws an invalid-request error without trying the backup", async () => {
    const primary = failingModel(
      "primary",
      new InvalidRequestError("bad model"),
    );
    const backup = okModel("backup");

    await expect(
      fallbackModel([primary, backup]).complete(userMessage),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(backup.callCount).toBe(0);
  });
});

describe("fallbackModel.complete — chain exhausted", () => {
  it("re-throws the LAST underlying provider error verbatim", async () => {
    const primary = failingModel("primary", new ProviderTimeoutError("t1"));
    const lastError = new ProviderRateLimitError("final 429");
    const backup = failingModel("backup", lastError);

    const model = fallbackModel([primary, backup]);

    await expect(model.complete(userMessage)).rejects.toBe(lastError);
  });
});

describe("fallbackModel — custom retryOn", () => {
  it("accepts an explicit allow-list of error codes", async () => {
    const primary = failingModel(
      "primary",
      new ProviderAuthError("normally not retried"),
    );
    const backup = okModel("backup", "recovered");

    const model = fallbackModel([primary, backup], {
      retryOn: ["PROVIDER_AUTH"],
    });
    const response = await model.complete(userMessage);

    expect(response.content).toBe("recovered");
  });

  it("does NOT fall over on a code outside the allow-list", async () => {
    const primary = failingModel(
      "primary",
      new ProviderRateLimitError("429"),
    );
    const backup = okModel("backup");

    const model = fallbackModel([primary, backup], {
      retryOn: ["PROVIDER_TIMEOUT"],
    });

    await expect(model.complete(userMessage)).rejects.toBeInstanceOf(
      ProviderRateLimitError,
    );
    expect(backup.callCount).toBe(0);
  });

  it("accepts a predicate function", async () => {
    const primary = failingModel(
      "primary",
      new InvalidRequestError("treat as retryable"),
    );
    const backup = okModel("backup", "recovered");

    const model = fallbackModel([primary, backup], {
      retryOn: (error) => error instanceof ProviderError,
    });
    const response = await model.complete(userMessage);

    expect(response.content).toBe("recovered");
  });

  it("does not fall over for a non-AIError when using the default predicate", async () => {
    const primary = failingModel("primary", new Error("plain error"));
    const backup = okModel("backup");

    await expect(
      fallbackModel([primary, backup]).complete(userMessage),
    ).rejects.toThrowError("plain error");
    expect(backup.callCount).toBe(0);
  });
});

describe("fallbackModel — usage aggregation", () => {
  it("returns only the successful model's usage (failed attempts contribute nothing)", async () => {
    const primary = failingModel("primary", new ProviderTimeoutError("t"));
    const backup = new MockModel("backup", [
      {
        content: "ok",
        finishReason: "stop",
        usage: { input: 100, output: 50, total: 150 },
      },
    ]);

    const response = await fallbackModel([primary, backup]).complete(
      userMessage,
    );

    expect(response.usage.input).toBe(100);
    expect(response.usage.output).toBe(50);
    expect(response.usage.total).toBe(150);
  });

  it("sums optional usage channels from the successful response", async () => {
    const backup = new MockModel("backup", [
      {
        content: "ok",
        finishReason: "stop",
        usage: { input: 10, output: 5, total: 15, cachedTokens: 4 },
      },
    ]);

    const response = await fallbackModel([
      failingModel("primary", new ProviderError("5xx")),
      backup,
    ]).complete(userMessage);

    expect(response.usage.cachedTokens).toBe(4);
  });
});

describe("fallbackModel — lastAttempts", () => {
  it("records each failed model in attempt order", async () => {
    const first = failingModel("first", new ProviderTimeoutError("t"));
    const second = failingModel("second", new ProviderRateLimitError("r"));
    const third = okModel("third");

    const model = fallbackModel([first, second, third]);
    await model.complete(userMessage);

    expect(model.lastAttempts.map((attempt) => attempt.modelName)).toEqual([
      "first",
      "second",
    ]);
  });

  it("is empty when the primary model succeeds", async () => {
    const model = fallbackModel([okModel("primary"), okModel("backup")]);
    await model.complete(userMessage);

    expect(model.lastAttempts).toEqual([]);
  });
});

describe("fallbackModel.stream — fall-over", () => {
  it("uses the primary model when it streams successfully", async () => {
    const primary = okModel("primary", "hello world");
    const backup = okModel("backup", "unused");

    const chunks = await collect(fallbackModel([primary, backup]).stream(userMessage));
    const text = chunks
      .filter((chunk): chunk is { type: "delta"; content: string } => chunk.type === "delta")
      .map((chunk) => chunk.content)
      .join("");

    expect(text.trim()).toBe("hello world");
    expect(backup.callCount).toBe(0);
  });

  it("falls over before any chunk is emitted", async () => {
    const primary = failingModel("primary", new ProviderRateLimitError("429"));
    const backup = okModel("backup", "recovered");

    const chunks = await collect(fallbackModel([primary, backup]).stream(userMessage));
    const done = chunks.find((chunk) => chunk.type === "done");

    expect(done).toBeDefined();
    expect(backup.callCount).toBe(1);
  });

  it("replaces the done chunk usage with the aggregated chain total", async () => {
    const backup = new MockModel("backup", [
      {
        content: "ok",
        finishReason: "stop",
        usage: { input: 7, output: 3, total: 10 },
      },
    ]);

    const chunks = await collect(
      fallbackModel([
        failingModel("primary", new ProviderTimeoutError("t")),
        backup,
      ]).stream(userMessage),
    );

    const done = chunks.find(
      (chunk): chunk is Extract<ModelStreamChunk, { type: "done" }> =>
        chunk.type === "done",
    );

    expect(done?.usage.total).toBe(10);
  });

  it("does not fall over once a chunk has been emitted mid-stream", async () => {
    const partialModel: ModelContract = {
      name: "partial",
      provider: "mock",
      async complete(): Promise<ModelResponse> {
        throw new Error("not used");
      },
      async *stream(): AsyncIterable<ModelStreamChunk> {
        yield { type: "delta", content: "partial " };
        throw new ProviderTimeoutError("died mid-stream");
      },
    };
    const backup = okModel("backup", "should-not-run");

    const stream = fallbackModel([partialModel, backup]).stream(userMessage);

    await expect(collect(stream)).rejects.toBeInstanceOf(ProviderTimeoutError);
    expect(backup.callCount).toBe(0);
  });
});
