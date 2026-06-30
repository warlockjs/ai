import type { Chunk } from "../contracts/chunk-options.type";

/** Default separators for the recursive splitter, tried largest-unit first. */
export const DEFAULT_SEPARATORS: string[] = ["\n\n", "\n", ". ", " ", ""];

/**
 * Recursive character splitter (the default strategy).
 *
 * Walks `separators` largest-unit-first: it splits the text on the first
 * separator, then packs the resulting pieces into chunks up to `size`
 * characters, carrying `overlap` characters forward between adjacent
 * chunks. Any single piece that is itself larger than `size` is split
 * again on the next-finer separator, recursing until a piece fits (the
 * `""` separator is the final char-by-char fallback).
 *
 * Every emitted chunk records its exact `[start, end)` character span in
 * the ORIGINAL text so a citation can point back precisely — spans are
 * tracked by index-of search as packed pieces are joined.
 *
 * Character-based and deliberately tokenizer-free.
 */
export function recursiveChunk(
  text: string,
  size: number,
  overlap: number,
  separators: string[] = DEFAULT_SEPARATORS,
): Chunk[] {
  const pieces = splitToPieces(text, size, separators);

  // Re-anchor each packed piece to its absolute offset in `text`. Pieces
  // are non-overlapping and in document order, so a forward cursor finds
  // each one's true start even when the same substring repeats.
  const spans = anchorPieces(text, pieces);

  return packPieces(text, spans, size, overlap);
}

/**
 * Recursively split `text` into pieces no larger than `size` using the
 * ordered separator list. Pieces preserve original characters (no
 * trimming) so downstream span anchoring stays exact.
 */
function splitToPieces(text: string, size: number, separators: string[]): string[] {
  if (text.length <= size) {
    return text.length > 0 ? [text] : [];
  }

  const [separator, ...rest] = separators;

  // Exhausted every separator (or hit the char fallback) — hard-split by
  // size so an oversize unit never blows the budget.
  if (separator === undefined || separator === "") {
    return hardSplit(text, size);
  }

  const segments = splitKeepingSeparator(text, separator);
  const pieces: string[] = [];

  for (const segment of segments) {
    if (segment.length === 0) {
      continue;
    }

    if (segment.length <= size) {
      pieces.push(segment);

      continue;
    }

    pieces.push(...splitToPieces(segment, size, rest));
  }

  return pieces;
}

/**
 * Split on `separator` but re-attach the separator to the end of each
 * preceding segment, so concatenating the segments reconstructs the
 * original text verbatim (keeping spans exact).
 */
function splitKeepingSeparator(text: string, separator: string): string[] {
  const raw = text.split(separator);
  const segments: string[] = [];

  raw.forEach((part, position) => {
    const isLast = position === raw.length - 1;

    segments.push(isLast ? part : part + separator);
  });

  return segments;
}

/** Hard char-window split for a unit larger than `size` with no usable separator. */
function hardSplit(text: string, size: number): string[] {
  const pieces: string[] = [];

  for (let cursor = 0; cursor < text.length; cursor += size) {
    pieces.push(text.slice(cursor, cursor + size));
  }

  return pieces;
}

/** A piece plus its absolute `[start, end)` span in the original text. */
type AnchoredPiece = {
  text: string;
  start: number;
  end: number;
};

/**
 * Map each piece back to its absolute offset using a monotonic cursor —
 * pieces are emitted in document order, so the next occurrence at-or-after
 * the cursor is the correct one even for repeated substrings.
 */
function anchorPieces(text: string, pieces: string[]): AnchoredPiece[] {
  const anchored: AnchoredPiece[] = [];
  let cursor = 0;

  for (const piece of pieces) {
    const start = text.indexOf(piece, cursor);
    const resolvedStart = start === -1 ? cursor : start;
    const end = resolvedStart + piece.length;

    anchored.push({ text: piece, start: resolvedStart, end });
    cursor = end;
  }

  return anchored;
}

/**
 * Greedily pack anchored pieces into chunks up to `size` characters, then
 * carry `overlap` trailing characters from each emitted chunk into the
 * next so context is not lost at a boundary. Spans are taken straight
 * from the anchored pieces, so the overlap text is part of the next
 * chunk's span exactly.
 */
function packPieces(
  text: string,
  pieces: AnchoredPiece[],
  size: number,
  overlap: number,
): Chunk[] {
  const chunks: Chunk[] = [];

  let bufferStart = -1;
  let bufferEnd = -1;
  let index = 0;

  const flush = (): void => {
    if (bufferStart === -1) {
      return;
    }

    chunks.push({
      text: text.slice(bufferStart, bufferEnd),
      index,
      span: [bufferStart, bufferEnd],
    });
    index += 1;
  };

  for (const piece of pieces) {
    if (bufferStart === -1) {
      bufferStart = piece.start;
      bufferEnd = piece.end;

      continue;
    }

    const projected = piece.end - bufferStart;

    if (projected <= size) {
      bufferEnd = piece.end;

      continue;
    }

    flush();

    // Start the next buffer `overlap` chars before this piece (clamped to
    // the previous chunk's start) so adjacent chunks share context.
    const overlapStart = overlap > 0 ? Math.max(bufferStart, piece.start - overlap) : piece.start;

    bufferStart = overlapStart;
    bufferEnd = piece.end;
  }

  flush();

  return chunks;
}
