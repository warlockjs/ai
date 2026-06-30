import type { Message } from "../contracts/conversation-message.type";
import type { ModelCallOptions } from "../contracts/model.contract";
import type { ToolConfig } from "../contracts/tool.contract";

/**
 * Default `ModelCallOptions` fields folded into the request hash. These are
 * the inputs that materially change the model's output; everything else
 * (notably `signal` and unknown provider keys) is excluded so an otherwise
 * identical logical call still matches its recording.
 */
export const DEFAULT_HASH_OPTIONS: readonly string[] = [
  "temperature",
  "maxTokens",
  "responseSchema",
  "tools",
  "reasoning",
];

/**
 * Reduce a tool to the parts the model actually conditions on: its name,
 * description, and the *shape* of its input schema. Two tools that differ
 * only by object identity (a fresh schema instance per import) hash
 * identically; a real contract change (renamed field, new description)
 * invalidates the recording.
 *
 * The input schema is fingerprinted structurally — a Standard Schema is an
 * opaque object, so we serialize its enumerable own keys rather than
 * attempting to read its internals.
 */
function fingerprintTool(tool: ToolConfig<unknown, unknown>): unknown {
  return {
    name: tool.name,
    description: tool.description,
    input: tool.input ? schemaShape(tool.input) : undefined,
  };
}

/**
 * Produce a stable, JSON-safe fingerprint of an arbitrary schema object.
 * Records only the structural skeleton (own enumerable keys, recursively)
 * so harmless instance differences don't perturb the hash while a genuine
 * structural change does.
 */
function schemaShape(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") {
    return typeof value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => schemaShape(item, depth + 1));
  }

  const out: Record<string, unknown> = {};

  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = schemaShape((value as Record<string, unknown>)[key], depth + 1);
  }

  return out;
}

/**
 * Pick the hashable subset of `options`, normalizing `tools` into their
 * name+description+schema-shape fingerprint. `signal` and any field not in
 * `hashOptions` are dropped.
 */
function pickOptions(
  options: ModelCallOptions | undefined,
  hashOptions: readonly string[],
): Record<string, unknown> {
  if (!options) {
    return {};
  }

  const picked: Record<string, unknown> = {};

  for (const key of hashOptions) {
    const value = options[key];

    if (value === undefined) {
      continue;
    }

    if (key === "tools" && Array.isArray(value)) {
      picked[key] = (value as ToolConfig<unknown, unknown>[]).map(fingerprintTool);
      continue;
    }

    picked[key] = value;
  }

  return picked;
}

/**
 * Recursively sort object keys so two logically-equal payloads serialize to
 * byte-identical JSON regardless of property insertion order.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  const out: Record<string, unknown> = {};

  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key]);
  }

  return out;
}

/**
 * Non-cryptographic 53-bit string hash (FNV-style, cyrb53). Deterministic
 * across runs and platforms; collision-resistant enough for a per-cassette
 * keyspace. Returned as a base-36 string.
 */
function hashString(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;

  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);

    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);

  return combined.toString(36);
}

/**
 * Compute the stable VCR request hash for a model call.
 *
 * The hash covers the full `messages` array plus the picked, normalized
 * `options` subset (see {@link DEFAULT_HASH_OPTIONS}). Inputs are
 * canonicalized (recursive key sort) before serialization so property order
 * never affects the result. `signal` and unknown provider keys are excluded.
 *
 * @example
 * const a = hashRequest(messages, { temperature: 0.2 });
 * const b = hashRequest(messages, { temperature: 0.2, signal });
 * // a === b — signal is excluded.
 */
export function hashRequest(
  messages: Message[],
  options?: ModelCallOptions,
  hashOptions: readonly string[] = DEFAULT_HASH_OPTIONS,
): string {
  const payload = canonicalize({
    messages,
    options: pickOptions(options, hashOptions),
  });

  return hashString(JSON.stringify(payload));
}
