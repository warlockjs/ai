import { describe, expect, it } from "vitest";
import { assignSafeKey, isUnsafeMergeKey, mergeSafely, UNSAFE_MERGE_KEYS } from "./safe-merge";

/**
 * Prototype-key guard for merges of model/tool-influenced data.
 *
 * Every fixture builds the dangerous key through a COMPUTED key or
 * `JSON.parse` — a plain `{ __proto__: ... }` literal is special-cased
 * by the language into a prototype set, which is not the shape an LLM
 * response produces after parsing.
 */
describe("safe-merge — dangerous key detection", () => {
  it("flags the prototype-tampering keys and nothing else", () => {
    expect(UNSAFE_MERGE_KEYS).toEqual(["__proto__", "constructor", "prototype"]);

    for (const key of UNSAFE_MERGE_KEYS) {
      expect(isUnsafeMergeKey(key)).toBe(true);
    }

    for (const key of ["response", "proto", "__proto", "Constructor", "toString", ""]) {
      expect(isUnsafeMergeKey(key)).toBe(false);
    }
  });
});

describe("safe-merge — assignSafeKey", () => {
  it("writes ordinary keys and reports success", () => {
    const target: Record<string, unknown> = {};

    expect(assignSafeKey(target, "response", "ok")).toBe(true);
    expect(target.response).toBe("ok");
  });

  it("refuses __proto__ without repointing the target's prototype", () => {
    const target: Record<string, unknown> = {};

    expect(assignSafeKey(target, "__proto__", { polluted: true })).toBe(false);
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect((target as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.keys(target)).toEqual([]);
  });

  it("refuses constructor and prototype", () => {
    const target: Record<string, unknown> = {};

    expect(assignSafeKey(target, "constructor", "hijacked")).toBe(false);
    expect(assignSafeKey(target, "prototype", "hijacked")).toBe(false);
    expect(target.constructor).toBe(Object);
    expect(Object.keys(target)).toEqual([]);
  });
});

describe("safe-merge — mergeSafely", () => {
  it("merges safe keys, drops dangerous ones, and returns what it dropped", () => {
    const target: Record<string, unknown> = { existing: 1 };
    const source = JSON.parse(
      '{"answer":"42","__proto__":{"isAdmin":true},"constructor":"x","prototype":"y"}',
    ) as Record<string, unknown>;

    const skipped = mergeSafely(target, source);

    expect(skipped.sort()).toEqual(["__proto__", "constructor", "prototype"]);
    expect(target).toEqual({ existing: 1, answer: "42" });
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect((target as { isAdmin?: unknown }).isAdmin).toBeUndefined();
  });

  it("returns an empty skip list for clean sources and mutates in place", () => {
    const target: Record<string, unknown> = { a: 1 };
    const reference = target;

    expect(mergeSafely(target, { b: 2, a: 3 })).toEqual([]);
    expect(reference).toEqual({ a: 3, b: 2 });
  });

  it("leaves the global Object.prototype untouched even under repeated attempts", () => {
    for (let index = 0; index < 3; index++) {
      mergeSafely({}, { ["__proto__"]: { globallyPolluted: true } });
    }

    expect(({} as { globallyPolluted?: unknown }).globallyPolluted).toBeUndefined();
  });
});
