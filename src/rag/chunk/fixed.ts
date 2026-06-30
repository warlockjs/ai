import type { Chunk } from "../contracts/chunk-options.type";

/**
 * Fixed-window character splitter.
 *
 * The simplest strategy: slices the text into back-to-back windows of
 * `size` characters, stepping forward by `size - overlap` so adjacent
 * windows share `overlap` characters. Boundary-unaware — it will cut
 * mid-word — but deterministic and dep-free. Spans are exact by
 * construction.
 */
export function fixedChunk(text: string, size: number, overlap: number): Chunk[] {
  if (text.length === 0) {
    return [];
  }

  const step = Math.max(1, size - overlap);
  const chunks: Chunk[] = [];
  let index = 0;

  for (let cursor = 0; cursor < text.length; cursor += step) {
    const start = cursor;
    const end = Math.min(cursor + size, text.length);

    chunks.push({ text: text.slice(start, end), index, span: [start, end] });
    index += 1;

    if (end >= text.length) {
      break;
    }
  }

  return chunks;
}
