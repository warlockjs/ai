import type { Message } from "../../contracts/conversation-message.type";
import type {
  ModelCallOptions,
  ModelCapabilities,
  ModelContract,
  ModelResponse,
  ModelStreamChunk,
} from "../../contracts/model.contract";
import type { ModelPricing } from "../../contracts/result/model-pricing.type";

/**
 * A scripted outcome for one call to {@link FakeModel}. Exactly one of
 * `response` / `chunks` / `error` should be set; the same script entry
 * services both `complete()` (uses `response`/`error`) and `stream()`
 * (uses `chunks`/`error`).
 */
export type FakeModelScript = {
  response?: ModelResponse;
  chunks?: ModelStreamChunk[];
  error?: Error;
};

/**
 * A minimal inner `ModelContract` for VCR specs. Counts `complete()` and
 * `stream()` calls and walks a scripted queue (last entry repeats when
 * exhausted, mirroring `MockModel`). Deliberately hand-rolled rather than
 * reusing `MockModel` so the VCR tests can assert the exact inner-call count
 * VCR makes (record vs replay) without `MockModel`'s word-splitting stream.
 */
export class FakeModel implements ModelContract {
  public completeCalls = 0;
  public streamCalls = 0;

  public readonly capabilities?: ModelCapabilities;
  public readonly pricing?: ModelPricing;

  private index = 0;

  public constructor(
    public readonly name: string = "fake-model",
    public readonly provider: string = "fake",
    private readonly script: FakeModelScript[] = [],
  ) {}

  /** Total times either `complete()` or `stream()` was invoked. */
  public get callCount(): number {
    return this.completeCalls + this.streamCalls;
  }

  private next(): FakeModelScript {
    const entry = this.script[Math.min(this.index, this.script.length - 1)];

    this.index++;

    return entry ?? { response: defaultResponse() };
  }

  public async complete(
    _messages: Message[],
    _options?: ModelCallOptions,
  ): Promise<ModelResponse> {
    this.completeCalls++;

    const entry = this.next();

    if (entry.error) {
      throw entry.error;
    }

    return entry.response ?? defaultResponse();
  }

  public async *stream(
    _messages: Message[],
    _options?: ModelCallOptions,
  ): AsyncIterable<ModelStreamChunk> {
    this.streamCalls++;

    const entry = this.next();

    if (entry.error) {
      throw entry.error;
    }

    const chunks = entry.chunks ?? defaultChunks();

    for (const chunk of chunks) {
      yield chunk;
    }
  }
}

/** A trivial valid `ModelResponse` used when a script entry is absent. */
function defaultResponse(): ModelResponse {
  return {
    content: "ok",
    finishReason: "stop",
    usage: { input: 1, output: 1, total: 2 },
  };
}

/** A trivial valid chunk sequence used when a script entry has none. */
function defaultChunks(): ModelStreamChunk[] {
  return [
    { type: "delta", content: "ok" },
    { type: "done", finishReason: "stop", usage: { input: 1, output: 1, total: 2 } },
  ];
}

/**
 * Convenience builder mirroring `new FakeModel(...)` without `new` at the
 * call site, for readability in specs.
 */
export function makeModel(script?: FakeModelScript[], name?: string, provider?: string): FakeModel {
  return new FakeModel(name, provider, script);
}
