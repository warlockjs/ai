import type { Message } from "../contracts/conversation-message.type";
import type {
  ModelCallOptions,
  ModelCapabilities,
  ModelContract,
  ModelResponse,
  ModelStreamChunk,
} from "../contracts/model.contract";
import type { MockModelResponse } from "./mock-config.type";

type RecordedCall = {
  messages: Message[];
  options?: ModelCallOptions;
};

/**
 * Deterministic in-memory `ModelContract` implementation for tests.
 *
 * **Role.** Stands in for a real provider model so agent/workflow/supervisor
 * tests can assert behavior without hitting the network, spending tokens, or
 * depending on non-deterministic LLM output.
 *
 * **Responsibility.**
 * - Owns: a scripted queue of `MockModelResponse` entries, a call-history
 *   log for assertions, and the index pointer that advances through the
 *   queue on each `complete()` / `stream()` call.
 * - Does NOT own: any real inference, tokenization, or network I/O — when
 *   the queue is exhausted, the final entry is reused so tests never crash
 *   on accidental over-consumption.
 *
 * Every AI-related test in this repo uses `MockSDK` / `MockModel` — real
 * provider APIs are never hit from the test suite (see §6 of code-style.md).
 *
 * @example
 * const model = new MockModel("mock-gpt", [
 *   { content: "Hello!", finishReason: "stop" },
 *   { content: "Second turn.", finishReason: "stop" },
 * ]);
 *
 * const first = await model.complete([{ role: "user", content: "hi" }]);
 * expect(first.content).toBe("Hello!");
 * expect(model.callCount).toBe(1);
 */
export class MockModel implements ModelContract {
  public readonly provider = "mock";
  public readonly capabilities?: ModelCapabilities;

  private responseIndex = 0;
  private calls: RecordedCall[] = [];

  public constructor(
    public readonly name: string,
    private readonly responses: MockModelResponse[],
    capabilities?: ModelCapabilities,
  ) {
    this.capabilities = capabilities;
  }

  /**
   * Full history of calls made to this model. Each entry is the exact
   * `{ messages, options }` pair that was passed — useful for asserting
   * that an agent built the right prompt or forwarded the right tool list.
   */
  public get callHistory(): RecordedCall[] {
    return this.calls;
  }

  /**
   * Number of times `complete()` or `stream()` has been invoked. Convenient
   * shorthand for `callHistory.length` in assertions.
   */
  public get callCount(): number {
    return this.calls.length;
  }

  /**
   * Advance the scripted response queue by one and return the entry at the
   * current pointer. If the queue is exhausted, the final scripted entry is
   * returned repeatedly so over-consumption in tests produces predictable
   * output instead of `undefined`.
   */
  private nextResponse(): MockModelResponse {
    const response = this.responses[Math.min(this.responseIndex, this.responses.length - 1)];

    this.responseIndex++;

    return response ?? { content: "Mock response", finishReason: "stop" };
  }

  /**
   * Convert a scripted `MockModelResponse` into a full `ModelResponse` with
   * synthesized usage numbers when the script didn't supply them. Input
   * usage is a fixed estimate; output usage is derived from content length.
   */
  private buildResponse(mock: MockModelResponse): ModelResponse {
    const estimatedInput = 10;
    const estimatedOutput = Math.ceil(mock.content.length / 4);

    return {
      content: mock.content,
      finishReason: mock.finishReason ?? "stop",
      usage: {
        input: mock.usage?.input ?? estimatedInput,
        output: mock.usage?.output ?? estimatedOutput,
        total: (mock.usage?.input ?? estimatedInput) + (mock.usage?.output ?? estimatedOutput),
        ...(mock.usage?.cachedTokens !== undefined ? { cachedTokens: mock.usage.cachedTokens } : {}),
      },
      toolCalls: mock.toolCalls,
    };
  }

  /**
   * Record the call, optionally delay (to simulate latency), and either
   * throw the scripted error or return the scripted response. Mirrors the
   * real provider's `complete()` contract so agents cannot tell the
   * difference at runtime.
   */
  public async complete(messages: Message[], options?: ModelCallOptions): Promise<ModelResponse> {
    this.calls.push({ messages, options });

    const mock = this.nextResponse();

    if (mock.delay) {
      await new Promise((resolve) => setTimeout(resolve, mock.delay));
    }

    if (mock.error) {
      throw mock.error;
    }

    return this.buildResponse(mock);
  }

  /**
   * Record the call, optionally delay, then emit the scripted response as a
   * sequence of stream chunks: content split word-by-word as `delta`
   * chunks, each scripted tool call as a `tool-call` chunk, and finally a
   * `done` chunk with finish reason + usage. Throws eagerly if the scripted
   * entry carries an `error`.
   */
  public async *stream(
    messages: Message[],
    options?: ModelCallOptions,
  ): AsyncIterable<ModelStreamChunk> {
    this.calls.push({ messages, options });

    const mock = this.nextResponse();

    if (mock.delay) {
      await new Promise((resolve) => setTimeout(resolve, mock.delay));
    }

    if (mock.error) {
      throw mock.error;
    }

    const words = mock.content.split(" ");

    for (const word of words) {
      yield { type: "delta", content: word + " " };
    }

    if (mock.toolCalls) {
      for (const toolCall of mock.toolCalls) {
        yield {
          type: "tool-call",
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
        };
      }
    }

    const response = this.buildResponse(mock);

    yield {
      type: "done",
      finishReason: response.finishReason,
      usage: response.usage,
    };
  }

  /**
   * Reset call history and response pointer back to their initial state.
   * Intended for test-suite `beforeEach` hooks so a single `MockModel`
   * instance can be reused across cases without cross-test leakage.
   */
  public reset(): void {
    this.calls = [];
    this.responseIndex = 0;
  }
}
