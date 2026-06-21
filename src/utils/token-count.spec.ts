import { describe, expect, it } from "vitest";
import { approximateTokenCount } from "./token-count";

describe("approximateTokenCount", () => {
  it("returns 0 for an empty string", () => {
    expect(approximateTokenCount("")).toBe(0);
  });

  it("rounds up — short strings still count as at least one token", () => {
    expect(approximateTokenCount("a")).toBe(1);
    expect(approximateTokenCount("abc")).toBe(1);
    expect(approximateTokenCount("abcd")).toBe(1);
  });

  it("uses the ~4-chars-per-token heuristic", () => {
    expect(approximateTokenCount("Hello, world!")).toBe(4); // 13 chars / 4 = 3.25 → 4
    expect(approximateTokenCount("12345678")).toBe(2); // 8 chars / 4 = 2
  });

  it("rounds up partial token boundaries", () => {
    expect(approximateTokenCount("12345")).toBe(2); // 5 chars / 4 = 1.25 → 2
    expect(approximateTokenCount("123456789")).toBe(3); // 9 / 4 = 2.25 → 3
  });

  it("handles whitespace and unicode characters by raw length", () => {
    expect(approximateTokenCount("    ")).toBe(1);
    expect(approximateTokenCount("héllo")).toBe(2); // 5 chars
  });

  it("scales linearly with length", () => {
    const small = approximateTokenCount("x".repeat(40));
    const large = approximateTokenCount("x".repeat(400));
    expect(small).toBe(10);
    expect(large).toBe(100);
  });
});
