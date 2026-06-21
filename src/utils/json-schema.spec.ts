import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it, vi } from "vitest";
import { extractJsonSchema } from "./json-schema";

/** Build a StandardSchemaV1 shell with a valid `~standard` slot. */
function makeStandardShell(
  extension: Record<string, unknown> = {},
): StandardSchemaV1<unknown> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: () => ({ value: null }),
      ...extension,
    },
  } as unknown as StandardSchemaV1<unknown>;
}

describe("extractJsonSchema — Seal / Standard JSON Schema V1 path", () => {
  it("calls jsonSchema.input() with the default 'openai-strict' target", () => {
    const inputFn = vi.fn(() => ({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    }));

    const schema = makeStandardShell({
      jsonSchema: { input: inputFn, output: vi.fn() },
    });

    const result = extractJsonSchema(schema);

    expect(inputFn).toHaveBeenCalledWith({ target: "openai-strict" });
    expect(result).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
  });

  it("forwards an explicit target when provided", () => {
    const inputFn = vi.fn(() => ({ type: "object", properties: {} }));

    const schema = makeStandardShell({
      jsonSchema: { input: inputFn, output: vi.fn() },
    });

    extractJsonSchema(schema, { target: "draft-2020-12" });

    expect(inputFn).toHaveBeenCalledWith({ target: "draft-2020-12" });
  });

  it("returns undefined when input() throws", () => {
    const schema = makeStandardShell({
      jsonSchema: {
        input: () => {
          throw new Error("unsupported target");
        },
        output: vi.fn(),
      },
    });

    expect(extractJsonSchema(schema)).toBeUndefined();
  });

  it("returns undefined when jsonSchema slot is missing", () => {
    const schema = makeStandardShell({});

    expect(extractJsonSchema(schema)).toBeUndefined();
  });
});

describe("extractJsonSchema — top-level fallback path", () => {
  it("reads a top-level jsonSchema property", () => {
    const schema = {
      "~standard": {
        version: 1,
        vendor: "t",
        validate: () => ({ value: null }),
      },
      jsonSchema: { type: "object", properties: { a: { type: "number" } } },
    } as unknown as StandardSchemaV1<unknown>;

    expect(extractJsonSchema(schema)).toEqual({
      type: "object",
      properties: { a: { type: "number" } },
    });
  });

  it("calls a top-level jsonSchema function", () => {
    const schema = {
      "~standard": {
        version: 1,
        vendor: "t",
        validate: () => ({ value: null }),
      },
      jsonSchema: () => ({ type: "object", properties: {} }),
    } as unknown as StandardSchemaV1<unknown>;

    expect(extractJsonSchema(schema)).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("does NOT probe toJSON (avoids dumping library internals)", () => {
    const toJSONSpy = vi.fn(() => ({
      rules: ["this", "is", "not", "json", "schema"],
    }));

    const schema = {
      "~standard": {
        version: 1,
        vendor: "t",
        validate: () => ({ value: null }),
      },
      toJSON: toJSONSpy,
    } as unknown as StandardSchemaV1<unknown>;

    expect(extractJsonSchema(schema)).toBeUndefined();
    expect(toJSONSpy).not.toHaveBeenCalled();
  });
});

describe("extractJsonSchema — priority", () => {
  it("prefers the Standard JSON Schema path over top-level jsonSchema", () => {
    const schema = {
      "~standard": {
        version: 1,
        vendor: "t",
        validate: () => ({ value: null }),
        jsonSchema: {
          input: () => ({ type: "object", properties: { fromStandard: {} } }),
          output: vi.fn(),
        },
      },
      jsonSchema: { type: "object", properties: { fromTopLevel: {} } },
    } as unknown as StandardSchemaV1<unknown>;

    const result = extractJsonSchema(schema);

    expect(result).toEqual({
      type: "object",
      properties: { fromStandard: {} },
    });
  });
});
