import { describe, expect, it } from "vitest";
import { extractJsonPayload } from "./extract-json-payload";

describe("extractJsonPayload", () => {
  it("returns plain JSON unchanged", () => {
    expect(extractJsonPayload('{"name":"Alex"}')).toBe('{"name":"Alex"}');
  });

  it("trims surrounding whitespace from plain JSON", () => {
    expect(extractJsonPayload('  \n{"a":1}\n  ')).toBe('{"a":1}');
  });

  it("unwraps a ```json fenced block", () => {
    const input = '```json\n{"name":"Alex"}\n```';

    expect(extractJsonPayload(input)).toBe('{"name":"Alex"}');
  });

  it("unwraps a fenced block with no language tag", () => {
    const input = '```\n{"name":"Alex"}\n```';

    expect(extractJsonPayload(input)).toBe('{"name":"Alex"}');
  });

  it("extracts the inner payload when prose surrounds the fence", () => {
    const input = 'Here you go:\n```json\n{"a":1}\n```\nHope this helps.';

    expect(extractJsonPayload(input)).toBe('{"a":1}');
  });

  it("preserves multiline JSON inside a fence", () => {
    const input = '```json\n{\n  "a": 1,\n  "b": 2\n}\n```';

    expect(extractJsonPayload(input)).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });

  it("takes the first fence when multiple are present", () => {
    const input =
      '```json\n{"first":true}\n```\n\n```json\n{"second":true}\n```';

    expect(extractJsonPayload(input)).toBe('{"first":true}');
  });

  it("returns the trimmed input when no fence is found", () => {
    expect(extractJsonPayload("not json at all")).toBe("not json at all");
  });

  it("returns empty string for empty input", () => {
    expect(extractJsonPayload("")).toBe("");
  });
});
