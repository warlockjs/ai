import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Message } from "../contracts/conversation-message.type";
import type { ModelCallOptions, ModelContract } from "../contracts/model.contract";
import type { Usage } from "../contracts/result/usage.type";
import { AIError, SchemaValidationError } from "../errors";
import { parsePartialJson } from "./parse-partial-json";

/**
 * One event in a {@link streamObject} run.
 *
 * - `text-delta` — the raw token text as it streams (for a "typing" view).
 * - `partial` — a best-effort snapshot of the object so far, re-parsed
 *   from the accumulated text on each delta (only emitted when it changed).
 * - `done` — terminal: the final text is strictly parsed and validated
 *   against the schema. `valid` + `value` on success; `valid: false` +
 *   `error` when the output wasn't valid JSON or failed the schema.
 */
export type ObjectStreamEvent<T> =
  | { type: "text-delta"; delta: string }
  | { type: "partial"; value: unknown }
  | { type: "done"; valid: true; value: T; usage: Usage }
  | { type: "done"; valid: false; error: AIError; usage: Usage };

/** Parameters for {@link streamObject}. */
export type StreamObjectParams<T> = {
  /** The model to stream from (e.g. `sdk.model({ name })`). */
  model: ModelContract;
  /** The prompt messages. */
  messages: Message[];
  /** Standard Schema the final object is validated against. */
  schema: StandardSchemaV1<T>;
  /** Extra model call options (e.g. `responseSchema`, `temperature`). */
  options?: ModelCallOptions;
};

/**
 * Stream a structured object: emit raw token deltas, progressively-parsed
 * partial-object snapshots, and a final strictly-validated object — the
 * first-class structured-output streaming primitive (A1). Reuses the
 * model's existing `stream()` seam; the partial snapshots come from a
 * tolerant {@link parsePartialJson}, while the terminal `done` event is a
 * strict `JSON.parse` + schema validation, so an over-eager partial parse
 * never affects the authoritative result.
 *
 * Pair it with a `structuredOutput`-capable model and a `responseSchema`
 * (via `options`) for the cleanest JSON; otherwise prompt the model to
 * reply with JSON only.
 *
 * @example
 * for await (const event of streamObject({ model, messages, schema })) {
 *   if (event.type === "partial") render(event.value);          // live UI
 *   if (event.type === "done" && event.valid) save(event.value); // final
 * }
 */
export async function* streamObject<T>(
  params: StreamObjectParams<T>,
): AsyncIterable<ObjectStreamEvent<T>> {
  const { model, messages, schema, options } = params;

  let accumulated = "";
  let lastPartialKey: string | undefined;
  let usage: Usage = { input: 0, output: 0, total: 0 };

  for await (const chunk of model.stream(messages, options)) {
    if (chunk.type === "delta") {
      accumulated += chunk.content;
      yield { type: "text-delta", delta: chunk.content };

      const partial = parsePartialJson(accumulated);
      if (partial !== undefined) {
        const key = safeStringify(partial);
        if (key !== lastPartialKey) {
          lastPartialKey = key;
          yield { type: "partial", value: partial };
        }
      }
    } else if (chunk.type === "done") {
      usage = chunk.usage;
    }
  }

  yield await finalize(accumulated, schema, usage);
}

/** Strict parse + schema validation of the complete streamed text. */
async function finalize<T>(
  text: string,
  schema: StandardSchemaV1<T>,
  usage: Usage,
): Promise<ObjectStreamEvent<T>> {
  const cleaned = stripJsonFences(text).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (cause) {
    return {
      type: "done",
      valid: false,
      error: new SchemaValidationError(
        "streamObject: the final streamed output was not valid JSON",
        { cause },
      ),
      usage,
    };
  }

  const result = await schema["~standard"].validate(parsed);
  if ("issues" in result && result.issues) {
    return {
      type: "done",
      valid: false,
      error: new SchemaValidationError(
        "streamObject: the streamed object failed schema validation",
        { issues: result.issues },
      ),
      usage,
    };
  }

  return { type: "done", valid: true, value: (result as { value: T }).value, usage };
}

/** Collect a {@link streamObject} run down to just its terminal event. */
export async function collectStreamObject<T>(
  stream: AsyncIterable<ObjectStreamEvent<T>>,
): Promise<Extract<ObjectStreamEvent<T>, { type: "done" }>> {
  let done: Extract<ObjectStreamEvent<T>, { type: "done" }> | undefined;
  for await (const event of stream) {
    if (event.type === "done") done = event;
  }
  if (!done) {
    throw new SchemaValidationError("streamObject: stream ended without a terminal event");
  }
  return done;
}

/** Strip a leading/trailing ```json fence the model may wrap output in. */
function stripJsonFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenced ? fenced[1] : text;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
