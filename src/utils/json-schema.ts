import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Supported JSON Schema output targets per the Standard JSON Schema V1
 * spec. `openai-strict` is the richest for OpenAI structured outputs —
 * every property listed in `required`, optionals expressed as
 * `["T", "null"]`, `additionalProperties: false` everywhere. Other
 * targets produce standards-compliant but looser output.
 */
export type JsonSchemaTarget = "draft-2020-12" | "draft-07" | "openapi-3.0" | "openai-strict";

/**
 * Options for `extractJsonSchema`. `target` is forwarded to libraries that
 * implement the Standard JSON Schema V1 spec (Seal, and any future lib
 * that follows the spec). Libraries using their own top-level `.jsonSchema`
 * / `._jsonSchema` property ignore the target.
 */
export type ExtractJsonSchemaOptions = {
  target?: JsonSchemaTarget | (string & {});
};

/**
 * Best-effort JSON Schema extraction from a Standard Schema instance.
 *
 * Different libraries expose their JSON representation through different
 * paths:
 * - **Seal / Standard JSON Schema V1**: `["~standard"].jsonSchema.input({ target })`
 *   — nested under the spec object, takes a target switch. Default target
 *   is `"openai-strict"` since the primary consumer is OpenAI's native
 *   structured-output mechanism; pass `options.target` to override.
 * - **Zod / similar**: top-level `.jsonSchema` property. Zod v4 actually
 *   ships `toJSONSchema` as a module function, not a method, so it does
 *   NOT hit this probe — Zod users pass their converted schema via the
 *   `AgentExecuteOptions.responseSchema` escape hatch.
 *
 * Deliberately does NOT probe `toJSON` — that's a generic JavaScript
 * serialization hook (Seal's schemas have one that dumps internal rule
 * state) and matching it would return garbage disguised as a JSON Schema.
 *
 * Returns `undefined` when no path matches. The caller then either skips
 * native structured-output wiring or falls back to a schema-less
 * instruction.
 *
 * Shared across every SDK adapter package (OpenAI, Anthropic, Bedrock…)
 * so each provider converts schemas identically.
 *
 * @example
 * const schema = extractJsonSchema(mySealSchema);
 * // { type: "object", properties: { ... }, required: [ ... ], additionalProperties: false }
 *
 * @example
 * // Ask for a different target explicitly
 * const draft = extractJsonSchema(mySealSchema, { target: "draft-2020-12" });
 */
export function extractJsonSchema(
  schema: StandardSchemaV1<unknown> | undefined,
  options: ExtractJsonSchemaOptions = {},
): Record<string, unknown> | undefined {
  if (!schema) return undefined;

  const target = options.target ?? "openai-strict";

  // 1. Seal / Standard JSON Schema V1 pattern: ["~standard"].jsonSchema.input({ target })
  const sealJsonSchema = extractFromSealPath(schema, target);

  if (sealJsonSchema) {
    return sealJsonSchema;
  }

  // 2. Top-level jsonSchema / _jsonSchema (Zod-like, property or method form)
  const topLevel = extractFromCandidateKeys(schema as unknown as Record<string, unknown>);

  if (topLevel) {
    return topLevel;
  }

  return undefined;
}

/**
 * Probe the Standard JSON Schema V1 extension path on `schema["~standard"]`.
 * The spec defines `jsonSchema.input({ target, libraryOptions? })` as a
 * function returning a JSON Schema tailored to the requested target. We
 * pass the caller's target (default `"openai-strict"`) so the library
 * produces output ready for OpenAI's native structured-output mode
 * without additional post-processing.
 *
 * Calling `.input()` without a target would throw (or return garbage) per
 * the spec — a failure here returns `undefined` so the fallback probe
 * runs.
 */
function extractFromSealPath(
  schema: StandardSchemaV1<unknown>,
  target: string,
): Record<string, unknown> | undefined {
  const standardSlot = (schema as unknown as Record<string, unknown>)["~standard"];

  if (!standardSlot || typeof standardSlot !== "object") {
    return undefined;
  }

  const jsonSchemaSlot = (standardSlot as Record<string, unknown>)["jsonSchema"];

  if (!jsonSchemaSlot || typeof jsonSchemaSlot !== "object") {
    return undefined;
  }

  const inputFn = (jsonSchemaSlot as Record<string, unknown>)["input"];

  if (typeof inputFn !== "function") {
    return undefined;
  }

  try {
    const result = (inputFn as (options: { target: string }) => unknown).call(jsonSchemaSlot, {
      target,
    });

    if (result && typeof result === "object") {
      return result as Record<string, unknown>;
    }
  } catch {
    // fall through — library didn't support the target or threw otherwise
  }

  return undefined;
}

/**
 * Probe well-known top-level keys libraries use to expose their JSON
 * Schema. Supports both method form (rare) and property form (common).
 * Deliberately narrow — `toJSON` is NOT probed here because it's a
 * generic serialization hook that returns library-internal state for
 * many validators (Seal included), not a JSON Schema.
 */
function extractFromCandidateKeys(
  schemaRecord: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const candidateKeys = ["jsonSchema", "_jsonSchema"] as const;

  for (const key of candidateKeys) {
    const value = schemaRecord[key];

    if (typeof value === "function") {
      try {
        const result = (value as () => unknown).call(schemaRecord);

        if (result && typeof result === "object") {
          return result as Record<string, unknown>;
        }
      } catch {
        // try next candidate
      }

      continue;
    }

    if (value && typeof value === "object") {
      return value as Record<string, unknown>;
    }
  }

  return undefined;
}
