import type { Message } from "../contracts/conversation-message.type";
import type {
  ModelCallOptions,
  ModelContract,
  ModelResponse,
  ModelStreamChunk,
} from "../contracts/model.contract";

/**
 * Record/replay mode for a {@link VcrModel}.
 *
 * - **`record`** — always call the inner model and append the result to
 *   the cassette. Never replays. Use to (re)capture a fresh cassette.
 * - **`replay`** — never call the inner model. A cassette hit returns the
 *   stored response/chunks/error; a miss throws `VcrCassetteMissError`
 *   (never a silent live call). Use in CI for deterministic, offline tests.
 * - **`auto`** (default) — replay on a cassette hit, record on a miss.
 *   The friendliest mode for local dev: records once, replays thereafter.
 */
export type VcrMode = "record" | "replay" | "auto";

/**
 * A single recorded request → response pair on a {@link Cassette}.
 *
 * Exactly one of `response` / `chunks` / `error` is populated, mirroring
 * the three outcomes of a model call: a non-streaming reply, a streamed
 * chunk sequence, or a thrown provider error.
 */
export type CassetteEntry = {
  /** Stable hash of the normalized request (messages + hashed options). */
  requestHash: string;
  /**
   * What was sent — stored verbatim for human readability and so the
   * cassette can be re-hashed if the hashing format ever changes.
   */
  request: {
    messages: Message[];
    options?: ModelCallOptions;
  };
  /** A non-streaming reply, recorded from `complete()`. */
  response?: ModelResponse;
  /** A streaming reply, captured from `stream()` as the ordered chunk list. */
  chunks?: ModelStreamChunk[];
  /** A thrown provider error, replayed by re-throwing a reconstructed `Error`. */
  error?: {
    name: string;
    message: string;
  };
};

/**
 * On-disk cassette format: the inner model identity plus every recorded
 * {@link CassetteEntry}. Serialized as JSON to {@link VcrOptions.path}.
 */
export type Cassette = {
  /** Cassette schema version. Bump only on a breaking format change. */
  version: 1;
  /** Inner `model.name` at record time — informational. */
  model: string;
  /** Inner `model.provider` at record time — informational. */
  provider: string;
  /** Recorded request → response pairs, in capture order. */
  entries: CassetteEntry[];
};

/**
 * Options for {@link vcr}.
 */
export type VcrOptions = {
  /** Cassette file path (JSON). Read on construct, written on `save()`. */
  path: string;
  /** Record/replay behavior. Default `"auto"`. */
  mode?: VcrMode;
  /**
   * Fields of `ModelCallOptions` to include in the request hash. Default
   * `["temperature","maxTokens","responseSchema","tools","reasoning"]`.
   * `signal` and unknown provider keys are always excluded so an
   * otherwise-identical logical call still matches. `tools` are hashed by
   * name + description + input-schema shape, not object identity.
   */
  hashOptions?: string[];
  /**
   * How the request BODY is persisted (S2). Replay matching is by the
   * recomputed hash, never the stored body — so privacy modes don't break
   * replay. Default `"verbatim"`.
   *
   * - `"verbatim"` — store the full request (prompts, tool args, options)
   *   for human-readable diffs and re-hashing. Records a loud one-time
   *   warning (outside tests) since the body may carry PII / secrets.
   * - `"redacted"` — run the request through {@link redactRequest}, or —
   *   without one — the key-based `redact()` (strips structured secrets
   *   like API keys in options; free-text prompts need a custom hook).
   * - `"hash-only"` — drop the request body entirely; keep only the hash
   *   and the outcome. Maximum privacy; loses human readability and the
   *   ability to re-hash.
   */
  recordRequest?: "verbatim" | "redacted" | "hash-only";
  /**
   * Custom request redactor for `recordRequest: "redacted"`. Receives the
   * `{ messages, options }` about to be stored; return a sanitized copy.
   * Overrides the default key-based `redact()`.
   */
  redactRequest?: (request: {
    messages: Message[];
    options?: ModelCallOptions;
  }) => { messages: Message[]; options?: ModelCallOptions };
  /**
   * Optional redactor for the recorded RESPONSE. Off by default — redacting
   * the response changes what replay returns, so opt in only when a secret
   * leaks into model output (e.g. an echoed token).
   */
  redactResponse?: (response: ModelResponse) => ModelResponse;
  /** Optional redactor for a recorded error's `{ name, message }`. */
  redactError?: (error: { name: string; message: string }) => {
    name: string;
    message: string;
  };
};

/**
 * A `ModelContract` decorator returned by {@link vcr}. Delegates
 * `name`/`provider`/`capabilities`/`pricing` to the inner model and
 * intercepts only `complete()`/`stream()`.
 */
export type VcrModel = ModelContract & {
  /** Flush newly recorded entries to `path`. No-op in pure replay. */
  save(): Promise<void>;
  /** Recorded/loaded entries, exposed for assertions. */
  readonly cassette: Cassette;
};
