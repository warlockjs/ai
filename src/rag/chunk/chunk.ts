import type { Chunk, ChunkOptions } from "../contracts/chunk-options.type";
import { fixedChunk } from "./fixed";
import { markdownChunk } from "./markdown";
import { DEFAULT_SEPARATORS, recursiveChunk } from "./recursive";
import { sentenceChunk } from "./sentence";

/** Default target chunk size in characters. */
export const DEFAULT_CHUNK_SIZE = 1000;

/** Default character overlap carried between adjacent chunks. */
export const DEFAULT_CHUNK_OVERLAP = 200;

/**
 * Split `text` into citation-bearing {@link Chunk}s according to
 * {@link ChunkOptions}, dispatching on `options.type`:
 *
 * - `"recursive"` (default) — separator-aware greedy packing.
 * - `"markdown"` — heading/section-aware, then recursive within sections.
 * - `"sentence"` — packs whole sentences.
 * - `"fixed"` — back-to-back character windows.
 *
 * All strategies are character-based (tokenizer-free) and record the exact
 * `[start, end)` span of every chunk in the original text. Empty or
 * whitespace-only input yields `[]`.
 *
 * @example
 * const chunks = chunk(markdownDoc, { type: "markdown", size: 800, overlap: 120 });
 * for (const c of chunks) console.log(c.index, c.span, c.text);
 */
export function chunk(text: string, options: ChunkOptions = {}): Chunk[] {
  const type = options.type ?? "recursive";
  const size = options.size ?? DEFAULT_CHUNK_SIZE;
  const overlap = options.overlap ?? DEFAULT_CHUNK_OVERLAP;
  const separators = options.separators ?? DEFAULT_SEPARATORS;

  // Empty or whitespace-only input yields no chunks — index() then writes
  // nothing and never embeds an empty batch.
  if (text.trim().length === 0) {
    return [];
  }

  switch (type) {
    case "markdown":
      return markdownChunk(text, size, overlap, separators);

    case "sentence":
      return sentenceChunk(text, size, overlap);

    case "fixed":
      return fixedChunk(text, size, overlap);

    case "recursive":
    default:
      return recursiveChunk(text, size, overlap, separators);
  }
}
