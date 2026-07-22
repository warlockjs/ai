/**
 * Default set of sensitive key fragments (matched case-insensitively as
 * substrings of an object key). Covers the secrets that leak through
 * recorded requests, error causes, and trace payloads: auth headers, API
 * keys, cookies, tokens, passwords, and private keys.
 */
export const DEFAULT_SENSITIVE_KEYS: readonly string[] = [
  "authorization",
  "x-api-key",
  "api-key",
  "apikey",
  "cookie",
  "set-cookie",
  "password",
  "passwd",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "client_secret",
  "private_key",
  "session",
];

/** HTTP header names always stripped from a serialized error/cause. */
export const SENSITIVE_HEADERS: readonly string[] = [
  "authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "set-cookie",
  "proxy-authorization",
];

export type RedactOptions = {
  /** Extra key fragments to redact, merged with {@link DEFAULT_SENSITIVE_KEYS}. */
  keys?: string[];
  /** Replacement for a redacted value. Default `"[redacted]"`. */
  placeholder?: string;
  /** Maximum recursion depth before bailing out. Default `8`. */
  maxDepth?: number;
};

const DEFAULT_PLACEHOLDER = "[redacted]";
const DEFAULT_MAX_DEPTH = 8;

function keyIsSensitive(key: string, fragments: string[]): boolean {
  const lower = key.toLowerCase();
  return fragments.some(fragment => lower.includes(fragment));
}

/**
 * Deep-copy `value` with any property whose KEY matches a sensitive
 * fragment replaced by the placeholder. Arrays are walked element-wise;
 * circular references and over-deep trees collapse to the placeholder.
 * Primitives pass through untouched (redaction is key-driven, not
 * value-driven — it never guesses at a bare string being a secret).
 *
 * Shared by VCR cassettes (S2), Panoptic content capture, and the error /
 * cause serializer (S4) so there is ONE redaction policy, not three.
 */
export function redact<T>(value: T, options: RedactOptions = {}): T {
  const fragments = [...DEFAULT_SENSITIVE_KEYS, ...(options.keys ?? [])].map(k =>
    k.toLowerCase(),
  );
  const placeholder = options.placeholder ?? DEFAULT_PLACEHOLDER;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const seen = new WeakSet<object>();

  const walk = (input: unknown, depth: number): unknown => {
    if (input === null || typeof input !== "object") {
      return input;
    }
    if (depth >= maxDepth || seen.has(input)) {
      return placeholder;
    }
    seen.add(input as object);

    if (Array.isArray(input)) {
      return input.map(item => walk(item, depth + 1));
    }

    // `name` / `message` / `stack` sit on Error's prototype chain (or as
    // non-enumerable own properties), so a plain `Object.entries()` walk
    // sees none of them — a raw Error `cause` would otherwise collapse to
    // `{}`. Project them explicitly; own enumerable extras (`code`,
    // `cause`, custom AIError fields) still merge in below and recurse
    // normally, so a chained `cause` that is itself an Error is unwrapped
    // the same way.
    const source: Record<string, unknown> =
      input instanceof Error
        ? { ...input, name: input.name, message: input.message, stack: input.stack }
        : (input as Record<string, unknown>);

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(source)) {
      out[key] = keyIsSensitive(key, fragments)
        ? placeholder
        : walk(val, depth + 1);
    }
    return out;
  };

  return walk(value, 0) as T;
}

/**
 * Strip sensitive HTTP headers from a `Headers` instance or a plain
 * header record, returning a redacted plain object. Header names are
 * matched case-insensitively against {@link SENSITIVE_HEADERS}.
 */
export function redactHeaders(
  headers: Headers | Record<string, unknown> | undefined,
  placeholder: string = DEFAULT_PLACEHOLDER,
): Record<string, unknown> {
  if (!headers) return {};

  const entries: Array<[string, unknown]> =
    headers instanceof Headers
      ? [...headers.entries()]
      : Object.entries(headers);

  const out: Record<string, unknown> = {};
  for (const [key, val] of entries) {
    out[key] = SENSITIVE_HEADERS.includes(key.toLowerCase()) ? placeholder : val;
  }
  return out;
}

/**
 * Patterns for secrets that hide in FREE TEXT (error messages, stack
 * traces, log lines) where the key-based {@link redact} can't reach them.
 * Each entry replaces the secret with `[redacted]` while keeping
 * surrounding context.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]"],
  [/\b(authorization|x-api-key|api[_-]?key|cookie)("?\s*[:=]\s*"?)[^\s",}]+/gi, "$1$2[redacted]"],
  [/\bsk-[A-Za-z0-9]{16,}\b/g, "[redacted]"], // OpenAI-style keys
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, "[redacted]"], // Slack tokens
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[redacted]"], // GitHub tokens
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"], // AWS access key ids
];

/**
 * Scrub secrets that appear in free-form text — error messages, stack
 * traces, exported log lines. Complements {@link redact} (which is key-
 * driven and can't see a token embedded in a string). Used by the trace /
 * error serializer (S4) before a message or stack is stored or exported.
 */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Serialized, secret-free view of an error. `stack` is omitted by default
 * (it can embed local paths, endpoints, and tokens); pass
 * `includeStack: true` only for a trusted local sink. The retained
 * `cause` is deep-redacted via {@link redact}, so a raw provider SDK error
 * carrying `Authorization` / `x-api-key` on `cause.headers` is sanitized.
 */
export type RedactedError = {
  name: string;
  message: string;
  code?: string;
  cause?: unknown;
  stack?: string;
};

export function redactError(
  error: unknown,
  options: { includeStack?: boolean } & RedactOptions = {},
): RedactedError {
  const { includeStack, ...redactOptions } = options;

  if (error === null || typeof error !== "object") {
    return { name: "Error", message: String(error) };
  }

  const err = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    cause?: unknown;
    stack?: unknown;
  };

  const result: RedactedError = {
    name: typeof err.name === "string" ? err.name : "Error",
    message: typeof err.message === "string" ? err.message : String(error),
  };

  if (typeof err.code === "string") {
    result.code = err.code;
  }
  if (err.cause !== undefined) {
    result.cause =
      err.cause !== null && typeof err.cause === "object"
        ? redact(err.cause, redactOptions)
        : err.cause;
  }
  if (includeStack && typeof err.stack === "string") {
    result.stack = err.stack;
  }

  return result;
}
