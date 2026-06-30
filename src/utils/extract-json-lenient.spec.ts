import { describe, expect, it } from "vitest";
import { extractJsonLenient } from "./extract-json-lenient";

describe("extractJsonLenient", () => {
  it("returns clean JSON unchanged", () => {
    expect(extractJsonLenient('{"score":0.9}')).toBe('{"score":0.9}');
  });

  it("unwraps a ```json fenced block", () => {
    expect(extractJsonLenient('```json\n{"score":0.9}\n```')).toBe('{"score":0.9}');
  });

  it("unwraps a fenced block with no language tag", () => {
    expect(extractJsonLenient('```\n{"verdict":"pass"}\n```')).toBe('{"verdict":"pass"}');
  });

  it("strips leading prose before a bare JSON object", () => {
    const input = 'Here is my verdict: {"score":0.7,"passed":true}';

    expect(extractJsonLenient(input)).toBe('{"score":0.7,"passed":true}');
  });

  it("strips trailing prose after a bare JSON object", () => {
    const input = '{"score":0.7} — hope that helps!';

    expect(extractJsonLenient(input)).toBe('{"score":0.7}');
  });

  it("strips both leading and trailing prose around the object", () => {
    const input = 'Sure thing.\n{"passed":false}\nLet me know if you need more.';

    expect(extractJsonLenient(input)).toBe('{"passed":false}');
  });

  it("recovers JSON wrapped in a fence AND surrounded by prose", () => {
    const input = 'My answer:\n```json\n{"a":1}\n```\nDone.';

    expect(extractJsonLenient(input)).toBe('{"a":1}');
  });

  it("ignores braces that appear inside string values", () => {
    const input = 'Verdict: {"reason":"the user wrote {weird} text","passed":true} ok';

    expect(extractJsonLenient(input)).toBe(
      '{"reason":"the user wrote {weird} text","passed":true}',
    );
  });

  it("honors escaped quotes inside string values", () => {
    const input = 'Note: {"reason":"they said \\"hi\\" loudly"} end';

    expect(extractJsonLenient(input)).toBe('{"reason":"they said \\"hi\\" loudly"}');
  });

  it("balances nested objects correctly", () => {
    const input = 'prefix {"outer":{"inner":{"deep":1}},"x":2} suffix';

    expect(extractJsonLenient(input)).toBe('{"outer":{"inner":{"deep":1}},"x":2}');
  });

  it("extracts a top-level JSON array", () => {
    const input = 'Items: [1, 2, {"k": 3}] done';

    expect(extractJsonLenient(input)).toBe('[1, 2, {"k": 3}]');
  });

  it("picks the earliest opener when an object precedes an array", () => {
    const input = 'x {"a":1} y [2] z';

    expect(extractJsonLenient(input)).toBe('{"a":1}');
  });

  it("returns the trimmed text when no balanced structure is present", () => {
    // Truncated / partial output — opener never closes, so nothing is
    // sliced and the loud parse failure is left to the caller.
    expect(extractJsonLenient('{"score":0.9')).toBe('{"score":0.9');
  });

  it("returns the trimmed text for pure prose with no JSON", () => {
    expect(extractJsonLenient("I think it deserves a pass.")).toBe(
      "I think it deserves a pass.",
    );
  });

  it("returns empty string for empty input", () => {
    expect(extractJsonLenient("")).toBe("");
  });
});
