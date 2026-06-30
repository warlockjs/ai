import { describe, expect, it } from "vitest";
import { chunk } from "./chunk";

/** Assert every chunk's recorded span actually slices to its text. */
function spansAreExact(text: string, chunks: ReturnType<typeof chunk>): boolean {
  return chunks.every((piece) => text.slice(piece.span[0], piece.span[1]) === piece.text);
}

describe("chunk — recursive (default)", () => {
  it("packs pieces up to size and emits indexed chunks", () => {
    const text = "alpha\n\nbravo\n\ncharlie\n\ndelta\n\necho";
    const chunks = chunk(text, { type: "recursive", size: 12, overlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((piece, position) => expect(piece.index).toBe(position));
    chunks.forEach((piece) => expect(piece.text.length).toBeLessThanOrEqual(12 + 6));
  });

  it("records exact [start, end) spans in the original text", () => {
    const text = "First paragraph here.\n\nSecond paragraph follows.\n\nThird one ends.";
    const chunks = chunk(text, { type: "recursive", size: 25, overlap: 0 });

    expect(spansAreExact(text, chunks)).toBe(true);
  });

  it("carries overlap characters forward between adjacent chunks", () => {
    const text = "0123456789\n\nabcdefghij\n\nABCDEFGHIJ";
    const noOverlap = chunk(text, { type: "recursive", size: 12, overlap: 0 });
    const withOverlap = chunk(text, { type: "recursive", size: 12, overlap: 5 });

    const overlapStart = withOverlap[1]?.span[0] ?? 0;
    const previousStart = noOverlap[1]?.span[0] ?? 0;

    expect(overlapStart).toBeLessThanOrEqual(previousStart);
  });

  it("hard-splits a single oversize unit with no usable separator", () => {
    const text = "x".repeat(50);
    const chunks = chunk(text, { type: "recursive", size: 10, overlap: 0 });

    expect(chunks.length).toBe(5);
    expect(spansAreExact(text, chunks)).toBe(true);
  });

  it("falls through separators largest-unit-first until a piece fits", () => {
    const text = "word ".repeat(20).trim();
    const chunks = chunk(text, { type: "recursive", size: 15, overlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(spansAreExact(text, chunks)).toBe(true);
  });

  it("returns one chunk when the text already fits size", () => {
    const text = "short text";
    const chunks = chunk(text, { type: "recursive", size: 1000, overlap: 0 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(text);
    expect(chunks[0].span).toEqual([0, text.length]);
  });
});

describe("chunk — markdown", () => {
  it("splits on heading boundaries keeping the heading with its body", () => {
    const text = "# Title\n\nIntro line.\n\n## Section A\n\nBody A.\n\n## Section B\n\nBody B.";
    const chunks = chunk(text, { type: "markdown", size: 1000, overlap: 0 });

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.some((piece) => piece.text.includes("## Section A"))).toBe(true);
    expect(spansAreExact(text, chunks)).toBe(true);
  });

  it("recurses within a section that exceeds size", () => {
    const body = "sentence one. ".repeat(20);
    const text = `# Big\n\n${body}`;
    const chunks = chunk(text, { type: "markdown", size: 40, overlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(spansAreExact(text, chunks)).toBe(true);
  });

  it("treats a heading-less document as one section", () => {
    const text = "Just plain text, no headings at all here.";
    const chunks = chunk(text, { type: "markdown", size: 1000, overlap: 0 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(text);
  });
});

describe("chunk — sentence", () => {
  it("packs whole sentences up to size", () => {
    const text = "One. Two. Three. Four. Five.";
    const chunks = chunk(text, { type: "sentence", size: 10, overlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(spansAreExact(text, chunks)).toBe(true);
  });
});

describe("chunk — fixed", () => {
  it("slices back-to-back windows with overlap", () => {
    const text = "abcdefghijklmnop";
    const chunks = chunk(text, { type: "fixed", size: 6, overlap: 2 });

    expect(chunks[0].text).toBe("abcdef");
    expect(chunks[1].span[0]).toBe(4);
    expect(spansAreExact(text, chunks)).toBe(true);
  });
});

describe("chunk — edge cases", () => {
  it("returns [] for empty input", () => {
    expect(chunk("", { type: "recursive" })).toEqual([]);
    expect(chunk("", { type: "markdown" })).toEqual([]);
    expect(chunk("", { type: "sentence" })).toEqual([]);
    expect(chunk("", { type: "fixed" })).toEqual([]);
  });

  it("returns [] for whitespace-only input under sentence splitting", () => {
    expect(chunk("   \n  ", { type: "sentence" })).toEqual([]);
  });
});
