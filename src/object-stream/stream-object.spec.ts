import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import type {
  ModelCallOptions,
  ModelContract,
  ModelResponse,
  ModelStreamChunk,
} from "../contracts/model.contract";
import { collectStreamObject, streamObject, type ObjectStreamEvent } from "./stream-object";

/** A model that streams a fixed sequence of text deltas, then `done`. */
class JsonStreamModel implements ModelContract {
  public readonly name = "m";
  public readonly provider = "p";

  public constructor(private readonly deltas: string[]) {}

  public async complete(): Promise<ModelResponse> {
    throw new Error("unused");
  }

  public async *stream(
    _messages: unknown,
    _options?: ModelCallOptions,
  ): AsyncIterable<ModelStreamChunk> {
    for (const content of this.deltas) {
      yield { type: "delta", content };
    }
    yield { type: "done", finishReason: "stop", usage: { input: 3, output: 4, total: 7 } };
  }
}

/** Hand-rolled Standard Schema for `{ name: string; age: number }`. */
const personSchema: StandardSchemaV1<{ name: string; age: number }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: value => {
      if (
        value &&
        typeof value === "object" &&
        typeof (value as { name?: unknown }).name === "string" &&
        typeof (value as { age?: unknown }).age === "number"
      ) {
        return { value: value as { name: string; age: number } };
      }
      return { issues: [{ message: "expected { name: string, age: number }" }] };
    },
  },
};

async function collect<T>(stream: AsyncIterable<ObjectStreamEvent<T>>) {
  const events: ObjectStreamEvent<T>[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("streamObject (A1)", () => {
  it("emits progressive partials and a valid final object", async () => {
    const model = new JsonStreamModel(['{"name":"A', 'da","ag', 'e":30}']);

    const events = await collect(
      streamObject({ model, messages: [{ role: "user", content: "who?" }], schema: personSchema }),
    );

    const partials = events.filter(e => e.type === "partial").map(e => (e as { value: unknown }).value);
    expect(partials).toContainEqual({ name: "Ada" }); // mid-stream snapshot

    const done = events.at(-1);
    expect(done).toEqual({
      type: "done",
      valid: true,
      value: { name: "Ada", age: 30 },
      usage: { input: 3, output: 4, total: 7 },
    });
  });

  it("surfaces a schema-validation failure on the terminal event", async () => {
    const model = new JsonStreamModel(['{"name":"Ada"}']); // missing `age`

    const done = await collectStreamObject(
      streamObject({ model, messages: [{ role: "user", content: "x" }], schema: personSchema }),
    );

    expect(done.valid).toBe(false);
    expect(done.valid === false && done.error.message).toMatch(/schema validation/);
  });

  it("surfaces invalid JSON on the terminal event", async () => {
    const model = new JsonStreamModel(["not json at all"]);

    const done = await collectStreamObject(
      streamObject({ model, messages: [{ role: "user", content: "x" }], schema: personSchema }),
    );

    expect(done.valid).toBe(false);
    expect(done.valid === false && done.error.message).toMatch(/not valid JSON/);
  });

  it("tolerates a ```json fenced final reply", async () => {
    const model = new JsonStreamModel(['```json\n{"name":"Bo","age":5}\n```']);

    const done = await collectStreamObject(
      streamObject({ model, messages: [{ role: "user", content: "x" }], schema: personSchema }),
    );

    expect(done.valid).toBe(true);
    expect(done.valid === true && done.value).toEqual({ name: "Bo", age: 5 });
  });
});
