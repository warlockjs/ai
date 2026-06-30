import type { Chunk } from "../contracts/chunk-options.type";

/** Matches a sentence terminator (`.`, `!`, `?`) followed by whitespace. */
const SENTENCE_BOUNDARY = /([.!?])\s+/g;

/**
 * Sentence-aware character splitter.
 *
 * Splits the text on sentence terminators (`. `, `! `, `? `), keeping the
 * terminator attached, then greedily packs whole sentences into chunks up
 * to `size` characters, carrying `overlap` characters forward between
 * adjacent chunks. A single sentence longer than `size` becomes its own
 * (oversize) chunk rather than being cut mid-sentence. Spans are exact.
 */
export function sentenceChunk(text: string, size: number, overlap: number): Chunk[] {
  if (text.trim().length === 0) {
    return [];
  }

  const sentences = splitSentences(text);
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

  for (const sentence of sentences) {
    if (bufferStart === -1) {
      bufferStart = sentence.start;
      bufferEnd = sentence.end;

      continue;
    }

    if (sentence.end - bufferStart <= size) {
      bufferEnd = sentence.end;

      continue;
    }

    flush();

    const overlapStart =
      overlap > 0 ? Math.max(bufferStart, sentence.start - overlap) : sentence.start;

    bufferStart = overlapStart;
    bufferEnd = sentence.end;
  }

  flush();

  return chunks;
}

/** A sentence with its absolute `[start, end)` span in the original text. */
type SentenceSpan = {
  start: number;
  end: number;
};

/**
 * Split `text` into sentence spans on terminator + whitespace, keeping the
 * terminator with its sentence and absorbing the trailing whitespace into
 * the boundary so reconstructing the spans loses no characters.
 */
function splitSentences(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  let start = 0;
  let match: RegExpExecArray | null;

  SENTENCE_BOUNDARY.lastIndex = 0;

  while ((match = SENTENCE_BOUNDARY.exec(text)) !== null) {
    const end = match.index + match[0].length;

    spans.push({ start, end });
    start = end;
  }

  if (start < text.length) {
    spans.push({ start, end: text.length });
  }

  return spans;
}
