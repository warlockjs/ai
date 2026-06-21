import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ModelToolCallRequest } from "../contracts/model-tool-call-request.type";
import type { ToolContract } from "../tool/tool";

/**
 * Default cap on bytes accumulated in a single suspect buffer before
 * the guard gives up, flushes as text, and resets to pass-through.
 * Real envelope payloads observed in production leaks are well under
 * 1 KB; this is a safety valve against runaway / adversarial input.
 */
const DEFAULT_MAX_BUFFER_BYTES = 4096;

/**
 * Fence opener the guard recognizes in pass-through mode. Targets the
 * lowercase form ```` ```json ```` only — that is the form models
 * actually emit in the wild when they fence-wrap a JSON tool envelope.
 * Other languages / casings flush as plain text.
 */
const FENCE_OPENER = "```json";

/**
 * Closing fence sequence inside `bufferingFence` mode. Three backticks,
 * no language tag.
 */
const FENCE_CLOSER = "```";

/**
 * Options passed when constructing a `JsonStreamGuard`.
 *
 * The guard is deliberately framework-agnostic of *how* deltas are
 * emitted or how recovered calls are dispatched — callers wire those
 * via `onSafeDelta` / `onRecoveredCall`. This keeps the unit-testable
 * surface tiny and lets the agent loop own all event-emission policy.
 */
export type JsonStreamGuardOptions = {
  /** Tools the agent has registered for this trip. Envelope lookups use `.name`. */
  tools: ReadonlyArray<ToolContract<unknown, unknown>>;
  /**
   * Hard cap on a single suspect buffer's size. When exceeded, the
   * buffer is flushed verbatim as text and the guard returns to
   * pass-through. Defaults to {@link DEFAULT_MAX_BUFFER_BYTES}.
   */
  maxBufferBytes?: number;
  /**
   * Called for every chunk of text that survived the guard — exactly
   * what the consumer should treat as the visible delta. May be
   * called many times per `feed()` call, possibly with a single
   * character or with a multi-character flush.
   */
  onSafeDelta: (delta: string) => void;
  /**
   * Called once per envelope the guard successfully classifies as a
   * tool-call recovery. The request carries `recoveredFrom:
   * "stream-text"` so downstream consumers can distinguish synthesized
   * calls from real ones.
   */
  onRecoveredCall: (request: ModelToolCallRequest) => void;
};

/**
 * Per-trip state machine that intercepts streamed text deltas, detects
 * JSON envelopes the model has emitted as plain text (the
 * tool-call-leakage symptom), and synthesizes real `ModelToolCallRequest`
 * entries for them while suppressing the JSON from visible output.
 *
 * **Role.** A `JsonStreamGuard` is the per-trip implementation of the
 * opt-in `streamingToolGuard` config. It sits between the model
 * adapter's `delta` chunks and the agent's `agent.trip.streaming`
 * emit + `content` accumulator — text that survives the guard is what
 * the consumer sees and what the trip records as `output`.
 *
 * **Responsibility.**
 * - Owns: a small character-level state machine (pass-through,
 *   brace-buffering, fence-buffering), string-literal-aware brace
 *   tracking, fence-opener / fence-closer detection, named-envelope
 *   matching against registered tool schemas, buffer-cap enforcement.
 * - Does NOT own: event emission (delegated via callbacks), tool
 *   dispatch, `finishReason` normalization, dedupe vs. real tool
 *   calls — the agent loop handles all four.
 *
 * **Matcher tier — named envelope only (v1).** A buffer matches when
 * it parses as a JSON object containing both:
 *   - a `name` or `tool` key resolving to a registered tool name, AND
 *   - an `arguments` or `input` key whose value validates against the
 *     resolved tool's `~standard` schema.
 * Bare-object matching (where any registered tool's schema is the
 * sole signal) is deferred until tool input schemas are tight enough
 * to distinguish — `v.record(v.any())` would match everything.
 *
 * **Per-trip lifecycle.** One instance per trip. The agent loop calls
 * `feed(chunk)` for every `delta` chunk and `finalize()` exactly once
 * after the stream's `done` chunk. Mid-stream cancellation: the loop
 * simply stops calling `feed`; any open buffer is discarded with the
 * guard instance.
 *
 * Modeled as a class (see §4.2 of code-style.md — per-call execution
 * state across phases): the machine has 3 states, accumulators for
 * brace depth, string-literal escape tracking, and a synthesized-call
 * counter for stable ids across the trip.
 *
 * @example
 * // Inside the agent's streaming trip body:
 * const guard = new JsonStreamGuard({
 *   tools: this.config.tools ?? [],
 *   maxBufferBytes: guardConfig.maxBufferBytes,
 *   onSafeDelta: (delta) => {
 *     content += delta;
 *     this.emit("agent.trip.streaming", { delta, tripIndex });
 *   },
 *   onRecoveredCall: (request) => recoveredCalls.push(request),
 * });
 *
 * for await (const chunk of model.stream(messages, callOptions)) {
 *   if (chunk.type === "delta") await guard.feed(chunk.content);
 *   // ... other chunk types
 * }
 *
 * await guard.finalize();
 */
export class JsonStreamGuard {
  private readonly tools: ReadonlyArray<ToolContract<unknown, unknown>>;
  private readonly maxBufferBytes: number;
  private readonly onSafeDelta: (delta: string) => void;
  private readonly onRecoveredCall: (request: ModelToolCallRequest) => void;

  private mode: "passThrough" | "bufferingBrace" | "bufferingFence" = "passThrough";

  /**
   * Characters held back in pass-through mode while we resolve whether
   * a partial fence opener (`` ` ``, `` `` ``, `` ``` ``, `` ```j ``, …)
   * will complete or break. Always a strict prefix of {@link FENCE_OPENER};
   * emptied (and emitted verbatim) the moment a non-matching character
   * arrives.
   */
  private holdback = "";

  /**
   * Accumulator while `mode === "bufferingBrace"` or `"bufferingFence"`.
   * In brace mode it carries the JSON including the outermost `{`/`}`.
   * In fence mode it carries everything between the opener and the
   * closer (the opener and closer themselves are NOT in the buffer —
   * they are reconstructed only on a flush-as-text fallback).
   */
  private buffer = "";

  /**
   * Brace-depth counter for `bufferingBrace` mode. Increments on `{`,
   * decrements on `}` — but only when {@link inString} is false, so a
   * `{` inside a JSON string literal does not skew the depth. Buffer
   * closes when depth returns to zero.
   */
  private braceDepth = 0;

  /** True while the scanner is inside a `"..."` JSON string literal. */
  private inString = false;

  /**
   * True when the previous character inside a string literal was a
   * backslash, so the current character is escaped (`\"` does not end
   * the string; `\\` resets the flag without escaping anything else).
   */
  private escapeNext = false;

  /**
   * Trailing tail of the fence buffer used to detect the closing
   * ```` ``` ```` sequence. Length capped at the closer length; rotated
   * forward as new characters arrive.
   */
  private fenceCloseTail = "";

  /**
   * Count of envelopes the guard has successfully synthesized this
   * trip. Used to assign deterministic, collision-free ids on
   * recovered `ModelToolCallRequest` entries.
   */
  private recoveredCount = 0;

  public constructor(options: JsonStreamGuardOptions) {
    this.tools = options.tools;
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.onSafeDelta = options.onSafeDelta;
    this.onRecoveredCall = options.onRecoveredCall;
  }

  /**
   * Feed the next raw delta from the model. Splits the chunk into
   * characters and runs each through the state machine, awaiting
   * envelope classification whenever a buffer closes mid-chunk.
   *
   * The hot path (pass-through prose with no `{` / `` ` ``) is fully
   * synchronous — `await` here only blocks at buffer-close points,
   * which are rare in normal traffic.
   */
  public async feed(chunk: string): Promise<void> {
    for (let i = 0; i < chunk.length; i++) {
      await this.processChar(chunk[i]);
    }
  }

  /**
   * Stream ended. Anything still in the holdback was prose
   * misclassified as a partial fence opener — emit it. Anything still
   * in an open buffer never closed — emit it as text too (a leak
   * truncated mid-flight is still text the user partially saw).
   */
  public async finalize(): Promise<void> {
    if (this.holdback.length > 0) {
      this.onSafeDelta(this.holdback);
      this.holdback = "";
    }

    if (this.mode === "bufferingBrace") {
      this.flushBraceBufferAsText();
      return;
    }

    if (this.mode === "bufferingFence") {
      this.flushFenceBufferAsText();
    }
  }

  /**
   * True when at least one envelope was recovered this trip. The
   * agent loop reads this to override `finishReason` from `"stop"` to
   * `"tool_calls"` when the model reported a natural stop but the
   * guard found tool calls hiding in the text channel.
   */
  public hasRecoveredCalls(): boolean {
    return this.recoveredCount > 0;
  }

  /**
   * Route a single character based on the current mode. The
   * `passThrough` branch handles holdback expansion / flushing
   * iteratively (no recursion) so a character that "breaks" a fence
   * opener can be re-evaluated as a fresh pass-through input in the
   * same call.
   */
  private async processChar(char: string): Promise<void> {
    if (this.mode === "bufferingBrace") {
      await this.processBraceChar(char);
      return;
    }

    if (this.mode === "bufferingFence") {
      await this.processFenceChar(char);
      return;
    }

    let current = char;

    while (true) {
      if (this.holdback.length === 0 && current === "{") {
        this.openBraceBuffer(current);
        return;
      }

      const extended = this.holdback + current;

      if (this.isFenceOpenerPrefix(extended)) {
        this.holdback = extended;

        if (extended === FENCE_OPENER) {
          this.openFenceBuffer();
        }

        return;
      }

      if (this.holdback.length === 0) {
        this.onSafeDelta(current);
        return;
      }

      this.onSafeDelta(this.holdback);
      this.holdback = "";
    }
  }

  /**
   * Recognize any strict prefix of {@link FENCE_OPENER} including the
   * full string. Used to decide whether to keep extending the holdback
   * or flush it as plain text.
   */
  private isFenceOpenerPrefix(candidate: string): boolean {
    return candidate.length <= FENCE_OPENER.length && FENCE_OPENER.startsWith(candidate);
  }

  /**
   * Enter `bufferingBrace` mode with the seed `{` as the first buffer
   * character and the initial brace depth set to one. Any holdback at
   * this point was already a non-fence sequence so it stays empty.
   */
  private openBraceBuffer(seed: string): void {
    this.mode = "bufferingBrace";
    this.buffer = seed;
    this.braceDepth = 1;
    this.inString = false;
    this.escapeNext = false;
  }

  /**
   * Enter `bufferingFence` mode immediately after the opener
   * ```` ```json ```` matched in the holdback. Holdback resets;
   * subsequent characters accumulate into the buffer until the
   * closing fence is seen.
   */
  private openFenceBuffer(): void {
    this.mode = "bufferingFence";
    this.buffer = "";
    this.fenceCloseTail = "";
    this.holdback = "";
  }

  /**
   * Process one character while accumulating a brace-delimited JSON
   * object. Tracks string-literal context so `{` / `}` inside `"..."`
   * do not skew brace depth. Closes (and classifies) on balanced
   * braces; flushes-as-text on cap overflow.
   */
  private async processBraceChar(char: string): Promise<void> {
    this.buffer += char;

    if (this.inString) {
      if (this.escapeNext) {
        this.escapeNext = false;
        return;
      }

      if (char === "\\") {
        this.escapeNext = true;
        return;
      }

      if (char === '"') {
        this.inString = false;
      }

      this.guardBufferCap("brace");
      return;
    }

    if (char === '"') {
      this.inString = true;
      this.guardBufferCap("brace");
      return;
    }

    if (char === "{") {
      this.braceDepth++;
      this.guardBufferCap("brace");
      return;
    }

    if (char === "}") {
      this.braceDepth--;

      if (this.braceDepth === 0) {
        await this.closeBraceBuffer();
        return;
      }

      this.guardBufferCap("brace");
      return;
    }

    this.guardBufferCap("brace");
  }

  /**
   * Process one character while accumulating a fence-delimited JSON
   * block. The closing fence ```` ``` ```` ends the block; the closing
   * characters are NOT included in the classified buffer (they are
   * re-emitted only when the block flushes back to text).
   */
  private async processFenceChar(char: string): Promise<void> {
    this.fenceCloseTail += char;

    if (this.fenceCloseTail.length > FENCE_CLOSER.length) {
      this.fenceCloseTail = this.fenceCloseTail.slice(-FENCE_CLOSER.length);
    }

    if (this.fenceCloseTail === FENCE_CLOSER) {
      const innerLength = this.buffer.length - (FENCE_CLOSER.length - 1);
      this.buffer = this.buffer.slice(0, Math.max(0, innerLength));

      await this.closeFenceBuffer();
      return;
    }

    this.buffer += char;
    this.guardBufferCap("fence");
  }

  /**
   * Enforce the buffer-byte cap. When the current buffer exceeds the
   * cap, flush it back to the consumer as plain text and reset to
   * pass-through. Acts as a runaway / adversarial-input safety valve.
   */
  private guardBufferCap(source: "brace" | "fence"): void {
    if (this.buffer.length <= this.maxBufferBytes) {
      return;
    }

    if (source === "brace") {
      this.flushBraceBufferAsText();
      return;
    }

    this.flushFenceBufferAsText();
  }

  /**
   * Run the envelope matcher against the closed brace buffer. On a
   * match, synthesize a recovered `ModelToolCallRequest`; on no
   * match, flush the buffer back as plain text. Resets state to
   * pass-through either way.
   */
  private async closeBraceBuffer(): Promise<void> {
    const closed = this.buffer;

    this.resetToPassThrough();

    const matched = await this.tryMatchEnvelope(closed);

    if (matched) {
      return;
    }

    this.onSafeDelta(closed);
  }

  /**
   * Run the envelope matcher against the closed fence buffer. On a
   * match, synthesize a recovered call; on no match, flush as text
   * **with** the original opener and closer reconstructed so the
   * customer sees exactly the markdown the model emitted.
   */
  private async closeFenceBuffer(): Promise<void> {
    const closed = this.buffer;

    this.resetToPassThrough();

    const matched = await this.tryMatchEnvelope(closed);

    if (matched) {
      return;
    }

    this.onSafeDelta(`${FENCE_OPENER}${closed}${FENCE_CLOSER}`);
  }

  /**
   * Emit the brace-buffer verbatim as text and reset to pass-through.
   * Used on cap overflow and on `finalize()` for an unclosed buffer.
   */
  private flushBraceBufferAsText(): void {
    const closed = this.buffer;
    this.resetToPassThrough();
    this.onSafeDelta(closed);
  }

  /**
   * Emit the fence-buffer verbatim as text, reconstructing the
   * opener and closer so the original markdown structure is
   * preserved for the consumer.
   */
  private flushFenceBufferAsText(): void {
    const closed = this.buffer;
    this.resetToPassThrough();
    this.onSafeDelta(`${FENCE_OPENER}${closed}`);
  }

  /**
   * Reset all per-buffer state back to the pass-through baseline.
   * Called whenever a buffer closes — by recovery, by flush, or by
   * cap overflow — so the next character starts a fresh scan.
   */
  private resetToPassThrough(): void {
    this.mode = "passThrough";
    this.buffer = "";
    this.braceDepth = 0;
    this.inString = false;
    this.escapeNext = false;
    this.fenceCloseTail = "";
  }

  /**
   * Attempt to classify a closed buffer as a tool-call envelope. On
   * success, invoke `onRecoveredCall` with a synthesized request and
   * return `true`; on failure return `false` so the caller can flush
   * the buffer back as text.
   */
  private async tryMatchEnvelope(raw: string): Promise<boolean> {
    const parsed = safeParseJson(raw);

    if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
      return false;
    }

    const envelope = parsed as Record<string, unknown>;
    const candidateName = readString(envelope, "name") ?? readString(envelope, "tool");
    const candidateInput = readObject(envelope, "arguments") ?? readObject(envelope, "input");

    if (!candidateName || !candidateInput) {
      return false;
    }

    const tool = this.tools.find((entry) => entry.name === candidateName);

    if (!tool || !tool.input) {
      return false;
    }

    const schema = tool.input as StandardSchemaV1<unknown>;

    let validationResult: StandardSchemaV1.Result<unknown>;

    try {
      validationResult = await schema["~standard"].validate(candidateInput);
    } catch {
      return false;
    }

    if (validationResult.issues) {
      return false;
    }

    this.recoveredCount++;

    this.onRecoveredCall({
      id: `synth_${candidateName}_${this.recoveredCount}`,
      name: candidateName,
      input: validationResult.value,
      recoveredFrom: "stream-text",
    });

    return true;
  }
}

/**
 * Parse a JSON string returning `undefined` on any failure. Local to
 * the guard so it can distinguish "not JSON" from a parsed `null`
 * value, which `safeJsonParse` cannot — a parsed `null` is a valid
 * JSON value but not a valid envelope, and we want the difference.
 */
function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Read a string-typed field from an envelope candidate. Returns
 * `undefined` when the key is missing or the value is non-string —
 * the matcher rejects either case.
 */
function readString(envelope: Record<string, unknown>, key: string): string | undefined {
  const value = envelope[key];

  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Read an object-typed field from an envelope candidate. Returns
 * `undefined` when the key is missing or the value is not a
 * plain object (rejects arrays, primitives, null) — tool input
 * schemas always validate against an object root.
 */
function readObject(
  envelope: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = envelope[key];

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}
