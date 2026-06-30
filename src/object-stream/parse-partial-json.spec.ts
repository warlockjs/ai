import { describe, expect, it } from "vitest";
import { parsePartialJson } from "./parse-partial-json";

describe("parsePartialJson", () => {
  it("parses already-complete JSON", () => {
    expect(parsePartialJson('{"a":1,"b":[2,3]}')).toEqual({ a: 1, b: [2, 3] });
  });

  it("completes an open string value", () => {
    expect(parsePartialJson('{"name":"Al')).toEqual({ name: "Al" });
  });

  it("completes an open array", () => {
    expect(parsePartialJson('{"items":[1,2,')).toEqual({ items: [1, 2] });
  });

  it("drops a dangling object key with no value yet", () => {
    expect(parsePartialJson('{"a":1,"b"')).toEqual({ a: 1 });
  });

  it("fills a dangling key: with null", () => {
    expect(parsePartialJson('{"a":1,"b":')).toEqual({ a: 1, b: null });
  });

  it("handles nested partial objects", () => {
    expect(parsePartialJson('{"user":{"name":"Bo')).toEqual({ user: { name: "Bo" } });
  });

  it("handles a top-level partial array", () => {
    expect(parsePartialJson("[1, 2, 3")).toEqual([1, 2, 3]);
  });

  it("drops a partial trailing literal", () => {
    // `tr` (partial `true`) — value not yet known, collapses to null.
    expect(parsePartialJson('{"ready": tr')).toEqual({ ready: null });
  });

  it("returns undefined for empty / unparseable prefixes", () => {
    expect(parsePartialJson("")).toBeUndefined();
    expect(parsePartialJson("   ")).toBeUndefined();
  });
});
