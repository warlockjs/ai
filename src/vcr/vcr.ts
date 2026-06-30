import type { Message } from "../contracts/conversation-message.type";
import type {
  ModelCallOptions,
  ModelCapabilities,
  ModelContract,
  ModelResponse,
  ModelStreamChunk,
} from "../contracts/model.contract";
import type { ModelPricing } from "../contracts/result/model-pricing.type";
import { redact } from "../security/redact";
import { emptyCassette, loadCassette, saveCassette } from "./cassette-io";
import { VcrCassetteMissError } from "./errors";
import { DEFAULT_HASH_OPTIONS, hashRequest } from "./hash-request";
import type { Cassette, CassetteEntry, VcrMode, VcrModel, VcrOptions } from "./vcr.type";

/**
 * Internal decorator that wraps an inner `ModelContract`, intercepting only
 * `complete()`/`stream()` and delegating every identity getter to the inner
 * model. Drives the record/replay state machine over a single in-memory
 * {@link Cassette}.
 *
 * **Why a class.** It holds mutable per-instance state (the loaded cassette,
 * the dirty flag, the load promise) behind a stable `ModelContract` surface;
 * the public API is the `vcr()` factory, never `new`.
 */
class Vcr implements VcrModel {
  private readonly mode: VcrMode;
  private readonly path: string;
  private readonly hashOptions: readonly string[];

  /** Loaded + newly recorded entries. Mutated in place as we record. */
  private loadedCassette: Cassette;

  /** Set when an entry is recorded so `save()` knows there's work to flush. */
  private dirty = false;

  /** One-shot lazy load of the on-disk cassette, shared across calls. */
  private loadPromise: Promise<void> | undefined;

  /** Persisted-body privacy controls (S2). */
  private readonly recordRequest: NonNullable<VcrOptions["recordRequest"]>;
  private readonly redactRequestHook: VcrOptions["redactRequest"];
  private readonly redactResponseHook: VcrOptions["redactResponse"];
  private readonly redactErrorHook: VcrOptions["redactError"];

  /** Verbatim-recording warning fires at most once per instance. */
  private warnedVerbatim = false;

  public constructor(
    private readonly inner: ModelContract,
    options: VcrOptions,
  ) {
    this.path = options.path;
    this.mode = options.mode ?? "auto";
    this.hashOptions = options.hashOptions ?? DEFAULT_HASH_OPTIONS;
    this.recordRequest = options.recordRequest ?? "verbatim";
    this.redactRequestHook = options.redactRequest;
    this.redactResponseHook = options.redactResponse;
    this.redactErrorHook = options.redactError;
    this.loadedCassette = emptyCassette(inner.name, inner.provider);
  }

  /** Inner model identifier — delegated verbatim. */
  public get name(): string {
    return this.inner.name;
  }

  /** Inner provider — delegated verbatim. */
  public get provider(): string {
    return this.inner.provider;
  }

  /** Inner capability flags — delegated verbatim. */
  public get capabilities(): ModelCapabilities | undefined {
    return this.inner.capabilities;
  }

  /** Inner pricing — delegated verbatim so cost accounting is unchanged. */
  public get pricing(): ModelPricing | undefined {
    return this.inner.pricing;
  }

  /** Loaded/recorded cassette, exposed for assertions. */
  public get cassette(): Cassette {
    return this.loadedCassette;
  }

  /**
   * Load the on-disk cassette exactly once. Pure `record` mode skips the
   * read — it always writes fresh — but the in-memory cassette still starts
   * empty so a record run never accidentally replays a stale entry.
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loadPromise) {
      return this.loadPromise;
    }

    this.loadPromise =
      this.mode === "record"
        ? Promise.resolve()
        : (async () => {
            this.loadedCassette = await loadCassette(
              this.path,
              this.inner.name,
              this.inner.provider,
            );
          })();

    return this.loadPromise;
  }

  /** Find a recorded entry whose hash matches the current request. */
  private findEntry(hash: string): CassetteEntry | undefined {
    return this.loadedCassette.entries.find((entry) => entry.requestHash === hash);
  }

  /** Re-throw a recorded error by reconstructing a plain `Error`. */
  private throwRecordedError(entry: CassetteEntry): never {
    const error = new Error(entry.error?.message ?? "Recorded error");

    error.name = entry.error?.name ?? "Error";

    throw error;
  }

  /**
   * Non-streaming call. In `replay` a miss throws; in `auto`/`record` a miss
   * calls the inner model and records the outcome (response or error).
   */
  public async complete(messages: Message[], options?: ModelCallOptions): Promise<ModelResponse> {
    await this.ensureLoaded();

    const hash = hashRequest(messages, options, this.hashOptions);

    if (this.mode !== "record") {
      const entry = this.findEntry(hash);

      if (entry) {
        if (entry.error) {
          this.throwRecordedError(entry);
        }

        if (entry.response) {
          return entry.response;
        }
      }

      if (this.mode === "replay") {
        throw new VcrCassetteMissError(
          `No cassette entry for this request (model "${this.inner.name}", hash ${hash}).`,
          { requestHash: hash, path: this.path },
        );
      }
    }

    try {
      const response = await this.inner.complete(messages, options);

      this.record({ requestHash: hash, request: { messages, options }, response });

      return response;
    } catch (error) {
      this.record({
        requestHash: hash,
        request: { messages, options },
        error: { name: (error as Error).name, message: (error as Error).message },
      });

      throw error;
    }
  }

  /**
   * Streaming call. On replay the stored `chunks` are re-yielded in order
   * (reproducing the `delta`/`tool-call`/`done` sequence) or the stored
   * error is re-thrown. On record the inner stream is buffered into
   * `chunks[]` while being re-emitted, then recorded once exhausted.
   */
  public async *stream(
    messages: Message[],
    options?: ModelCallOptions,
  ): AsyncIterable<ModelStreamChunk> {
    await this.ensureLoaded();

    const hash = hashRequest(messages, options, this.hashOptions);

    if (this.mode !== "record") {
      const entry = this.findEntry(hash);

      if (entry) {
        if (entry.error) {
          this.throwRecordedError(entry);
        }

        if (entry.chunks) {
          for (const chunk of entry.chunks) {
            yield chunk;
          }

          return;
        }
      }

      if (this.mode === "replay") {
        throw new VcrCassetteMissError(
          `No cassette entry for this request (model "${this.inner.name}", hash ${hash}).`,
          { requestHash: hash, path: this.path },
        );
      }
    }

    const chunks: ModelStreamChunk[] = [];

    try {
      for await (const chunk of this.inner.stream(messages, options)) {
        chunks.push(chunk);

        yield chunk;
      }
    } catch (error) {
      this.record({
        requestHash: hash,
        request: { messages, options },
        error: { name: (error as Error).name, message: (error as Error).message },
      });

      throw error;
    }

    this.record({ requestHash: hash, request: { messages, options }, chunks });
  }

  /**
   * Append an entry to the in-memory cassette and mark it dirty, applying
   * the configured request/response/error redaction first (S2). Pure
   * `replay` never reaches this path, so no replay run is ever dirtied.
   */
  private record(entry: CassetteEntry): void {
    this.loadedCassette.entries.push(this.applyRedaction(entry));
    this.dirty = true;
    this.maybeWarnVerbatim();
  }

  /**
   * Apply the persisted-body privacy controls to an entry before it is
   * stored. The request body follows `recordRequest`; response/error
   * redactors are applied only when supplied. Replay matching is by the
   * recomputed hash (kept verbatim), so none of this affects replay.
   */
  private applyRedaction(entry: CassetteEntry): CassetteEntry {
    const out: CassetteEntry = {
      requestHash: entry.requestHash,
      request: entry.request,
    };

    if (this.recordRequest === "hash-only") {
      out.request = { messages: [] };
    } else if (this.recordRequest === "redacted") {
      out.request = this.redactRequestHook
        ? this.redactRequestHook(entry.request)
        : redact(entry.request);
    }

    if (entry.response) {
      out.response = this.redactResponseHook
        ? this.redactResponseHook(entry.response)
        : entry.response;
    }
    if (entry.chunks) {
      out.chunks = entry.chunks;
    }
    if (entry.error) {
      out.error = this.redactErrorHook
        ? this.redactErrorHook(entry.error)
        : entry.error;
    }

    return out;
  }

  /**
   * Warn once (outside tests) when the cassette is recording verbatim
   * request bodies — they may carry prompts, tool args, and PII, so the
   * file is not safe to commit until sanitized.
   */
  private maybeWarnVerbatim(): void {
    if (this.warnedVerbatim || this.recordRequest !== "verbatim") return;
    if (process.env.VITEST || process.env.NODE_ENV === "test") return;

    this.warnedVerbatim = true;
    console.warn(
      `[warlock-ai] VCR is recording verbatim request bodies to "${this.path}" — prompts, tool args, and any PII are stored unredacted. ` +
        'Sanitize before committing, or set recordRequest: "redacted" | "hash-only".',
    );
  }

  /**
   * Flush newly recorded entries to `path`. No-op when nothing was recorded
   * (pure replay, or a record/auto run that only ever hit cached entries).
   */
  public async save(): Promise<void> {
    if (!this.dirty) {
      return;
    }

    await saveCassette(this.path, this.loadedCassette);
    this.dirty = false;
  }
}

/**
 * Wrap any `ModelContract` in a record/replay decorator backed by a JSON
 * cassette on disk.
 *
 * **What it does.** Intercepts only `complete()`/`stream()` — the single
 * seam every agent trip funnels through — and delegates `name`, `provider`,
 * `capabilities`, and `pricing` to the inner model untouched. On a call it
 * computes a stable hash over `{ messages, picked options }` and, depending
 * on `mode`:
 *
 * - **`record`** — always calls the inner model and appends a cassette entry.
 * - **`replay`** — returns the matching entry (or re-yields its chunks /
 *   re-throws its error); a miss throws `VcrCassetteMissError`, never a live
 *   call.
 * - **`auto`** (default) — replays a hit, records a miss.
 *
 * Composes *below* `fallbackModel` and works with any adapter because it
 * depends only on `ModelContract`. Call `save()` to flush new entries.
 *
 * @example
 * const model = vcr(liveModel, { path: "./cassettes/support.json" });
 * const response = await model.complete(messages);
 * await model.save(); // first run records; later runs replay deterministically.
 */
export function vcr(model: ModelContract, options: VcrOptions): VcrModel {
  return new Vcr(model, options);
}
