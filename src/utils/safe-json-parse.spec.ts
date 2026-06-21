import { describe, expect, it } from "vitest";
import { safeJsonParse } from "./safe-json-parse";

describe("safeJsonParse", () => {
  it("parses valid JSON object input", () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 });
  });

  it("parses valid JSON array input", () => {
    expect(safeJsonParse<number[]>("[1,2,3]", [])).toEqual([1, 2, 3]);
  });

  it("parses valid JSON primitives", () => {
    expect(safeJsonParse<number>("42", 0)).toBe(42);
    expect(safeJsonParse<boolean>("true", false)).toBe(true);
    expect(
      safeJsonParse<null>("null", undefined as unknown as null),
    ).toBeNull();
  });

  it("returns the default for null input", () => {
    expect(safeJsonParse(null, { fallback: true })).toEqual({ fallback: true });
  });

  it("returns the default for undefined input", () => {
    expect(safeJsonParse(undefined, "fallback")).toBe("fallback");
  });

  it("returns the default for an empty string", () => {
    expect(safeJsonParse("", { fallback: true })).toEqual({ fallback: true });
  });

  it("returns the default for malformed JSON", () => {
    expect(safeJsonParse("{not json", { fallback: true })).toEqual({
      fallback: true,
    });
    expect(safeJsonParse("{a:1}", { fallback: true })).toEqual({
      fallback: true,
    });
    expect(safeJsonParse('{"a":}', { fallback: true })).toEqual({
      fallback: true,
    });
  });

  it("returns the default rather than throwing on truncated streaming JSON", () => {
    expect(safeJsonParse('{"city":"Cair', { city: "" })).toEqual({ city: "" });
  });

  it("preserves the typed return shape via the generic parameter", () => {
    type Args = { city: string; units?: "C" | "F" };
    const result = safeJsonParse<Args>('{"city":"Cairo","units":"C"}', {
      city: "",
    });
    expect(result.city).toBe("Cairo");
    expect(result.units).toBe("C");
  });
});
