import { describe, expect, it } from "vitest";
import { cloneState, deepFreeze } from "./state";

describe("cloneState", () => {
  it("produces a deep copy that is decoupled from the source", () => {
    const source = { a: 1, nested: { b: 2 }, list: [1, 2, 3] };
    const copy = cloneState(source);

    copy.nested.b = 99;
    copy.list.push(4);

    expect(source.nested.b).toBe(2);
    expect(source.list).toEqual([1, 2, 3]);
    expect(copy.nested.b).toBe(99);
  });

  it("preserves Date / Map / Set instances (structuredClone, not JSON round-trip)", () => {
    const source = {
      when: new Date("2024-01-02T03:04:05.000Z"),
      lookup: new Map([["k", "v"]]),
      tags: new Set(["x", "y"]),
    };
    const copy = cloneState(source);

    expect(copy.when).toBeInstanceOf(Date);
    expect(copy.when.toISOString()).toBe("2024-01-02T03:04:05.000Z");
    expect(copy.lookup).toBeInstanceOf(Map);
    expect(copy.lookup.get("k")).toBe("v");
    expect(copy.tags).toBeInstanceOf(Set);
    expect(copy.tags.has("x")).toBe(true);
  });

  it("returns primitives unchanged", () => {
    expect(cloneState(42)).toBe(42);
    expect(cloneState("hello")).toBe("hello");
    expect(cloneState(null)).toBe(null);
  });
});

describe("deepFreeze", () => {
  it("freezes the top-level object and every nested object / array", () => {
    const frozen = deepFreeze({ a: 1, nested: { b: 2 }, list: [{ c: 3 }] });

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.nested)).toBe(true);
    expect(Object.isFrozen(frozen.list)).toBe(true);
    expect(Object.isFrozen(frozen.list[0])).toBe(true);
  });

  it("returns the same reference (freezes in place, does not clone)", () => {
    const original = { a: 1 };
    const result = deepFreeze(original);

    expect(result).toBe(original);
  });

  it("makes nested mutation throw in strict mode", () => {
    "use strict";
    const frozen = deepFreeze({ nested: { b: 2 } });

    expect(() => {
      frozen.nested.b = 99;
    }).toThrow();
  });

  it("returns primitives and null unchanged", () => {
    expect(deepFreeze(42)).toBe(42);
    expect(deepFreeze("x")).toBe("x");
    expect(deepFreeze(null)).toBe(null);
    expect(deepFreeze(undefined)).toBe(undefined);
  });

  it("short-circuits on an already-frozen value without recursing", () => {
    // A pre-frozen object with an UNFROZEN child: deepFreeze bails at the
    // top via the `Object.isFrozen` guard, so the child stays mutable.
    // This pins the documented "already-frozen values are skipped" path.
    const child = { b: 2 };
    const parent = Object.freeze({ child });

    const result = deepFreeze(parent);

    expect(result).toBe(parent);
    expect(Object.isFrozen(child)).toBe(false);
  });
});
