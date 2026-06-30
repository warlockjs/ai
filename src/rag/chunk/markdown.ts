import type { Chunk } from "../contracts/chunk-options.type";
import { DEFAULT_SEPARATORS, recursiveChunk } from "./recursive";

/** Matches an ATX Markdown heading line (`#` … `######`) at line start. */
const HEADING_LINE = /^#{1,6}[ \t].*$/gm;

/**
 * Markdown heading/section-aware splitter.
 *
 * Splits the document on ATX heading boundaries (`#`…`######`) first so a
 * section's heading stays glued to its body, then applies the recursive
 * character splitter WITHIN each section so any section larger than `size`
 * is broken down further. Sections at or under `size` are emitted whole.
 * Spans are exact relative to the original document.
 */
export function markdownChunk(
  text: string,
  size: number,
  overlap: number,
  separators: string[] = DEFAULT_SEPARATORS,
): Chunk[] {
  if (text.length === 0) {
    return [];
  }

  const sections = splitSections(text);
  const chunks: Chunk[] = [];
  let index = 0;

  for (const section of sections) {
    const body = text.slice(section.start, section.end);

    if (body.trim().length === 0) {
      continue;
    }

    if (body.length <= size) {
      chunks.push({
        text: body,
        index,
        span: [section.start, section.end],
      });
      index += 1;

      continue;
    }

    // Recurse within the section, then shift the relative spans to
    // absolute document offsets and renumber sequentially.
    const inner = recursiveChunk(body, size, overlap, separators);

    for (const piece of inner) {
      chunks.push({
        text: piece.text,
        index,
        span: [section.start + piece.span[0], section.start + piece.span[1]],
      });
      index += 1;
    }
  }

  return chunks;
}

/** A section's absolute `[start, end)` span (heading line + body until next heading). */
type SectionSpan = {
  start: number;
  end: number;
};

/**
 * Carve the document into sections, each beginning at a heading line and
 * running until the next heading (the preamble before the first heading is
 * its own section). Spans cover the whole document with no gaps.
 */
function splitSections(text: string): SectionSpan[] {
  const starts: number[] = [];
  let match: RegExpExecArray | null;

  HEADING_LINE.lastIndex = 0;

  while ((match = HEADING_LINE.exec(text)) !== null) {
    starts.push(match.index);
  }

  // No headings at all — the whole document is one section.
  if (starts.length === 0) {
    return [{ start: 0, end: text.length }];
  }

  const sections: SectionSpan[] = [];

  // Preamble before the first heading, if any.
  if (starts[0] > 0) {
    sections.push({ start: 0, end: starts[0] });
  }

  starts.forEach((start, position) => {
    const end = position + 1 < starts.length ? starts[position + 1] : text.length;

    sections.push({ start, end });
  });

  return sections;
}
