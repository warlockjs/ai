import type { RagDocument } from "../contracts/rag-document.type";
import type { LoadHtmlOptions, RagLoaderResult } from "./loader.type";

/** Default `id` when the caller supplies none. */
const DEFAULT_ID = "document";

/**
 * Elements whose *content* is not human-readable text and must be removed
 * wholesale (open tag → close tag → everything in between) before tags are
 * stripped. `script` / `style` would otherwise leak code into the chunked
 * text; `noscript` / `template` / `head` / `svg` are non-prose noise.
 */
const STRIPPED_ELEMENTS = [
  "script",
  "style",
  "noscript",
  "template",
  "head",
  "svg",
];

/**
 * Block-level tags that imply a line break in the readable text. Replacing
 * them with `\n` BEFORE the generic tag strip keeps paragraph / list / table
 * structure (so the recursive splitter still sees `\n\n` boundaries) instead
 * of collapsing the whole page onto one line.
 */
const BLOCK_TAGS =
  /<\/?(?:p|div|section|article|header|footer|main|aside|nav|h[1-6]|ul|ol|li|table|tr|td|th|thead|tbody|blockquote|pre|hr|br)\b[^>]*>/gi;

/** Named HTML entities common in prose. Numeric entities are decoded generically. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
};

/**
 * Decode the HTML entities that survive tag stripping: named (`&amp;`),
 * decimal (`&#169;`), and hex (`&#xA9;`). Unknown named entities are left
 * verbatim rather than dropped, so unusual markup never silently loses text.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const codePoint =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);

      if (Number.isNaN(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        return match;
      }

      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }

    const named = NAMED_ENTITIES[body.toLowerCase()];

    return named ?? match;
  });
}

/**
 * Pull the `<title>` text out of the document, decoded and trimmed, or
 * `undefined` when there is none. Read BEFORE `<head>` is stripped.
 */
function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);

  if (!match) {
    return undefined;
  }

  const title = decodeEntities(match[1]).replace(/\s+/g, " ").trim();

  return title.length > 0 ? title : undefined;
}

/**
 * Strip HTML markup down to readable plain text — a lightweight,
 * dependency-free pass (no DOM parser): drop comments and non-prose elements
 * (`script` / `style` / `head` / `svg` / …) content-and-all, convert block
 * tags to line breaks to preserve paragraph structure, remove every
 * remaining tag, decode entities, then collapse runs of whitespace while
 * keeping blank-line paragraph separators.
 */
function htmlToText(html: string): string {
  let text = html;

  // 1. Comments first — a commented-out `<script>` must not survive.
  text = text.replace(/<!--[\s\S]*?-->/g, " ");

  // 2. Non-prose elements, content and all.
  for (const tag of STRIPPED_ELEMENTS) {
    const element = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    text = text.replace(element, " ");
    // Defensively drop a self-closing / unterminated open tag too.
    text = text.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"), " ");
  }

  // 3. Block tags → newlines, so paragraph / list structure survives.
  text = text.replace(BLOCK_TAGS, "\n");

  // 4. Every remaining tag → gone.
  text = text.replace(/<[^>]+>/g, "");

  // 5. Entities → characters.
  text = decodeEntities(text);

  // 6. Normalize whitespace: trim each line, drop blank runs to a single
  //    blank line (a paragraph separator the recursive splitter honors).
  text = text
    .replace(/[^\S\n]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

/**
 * Load an HTML string into a single {@link RagDocument} of readable text.
 * Scripts, styles, and other non-prose elements are dropped content-and-all,
 * block tags become line breaks (so paragraph structure survives for the
 * splitter), remaining tags are stripped, and HTML entities are decoded — a
 * lightweight regex pass, no heavy DOM dependency.
 *
 * The document's `metadata.title` is set from the page's `<title>` (unless
 * the caller overrode it), and `metadata.loader` is `"html"`. The output is
 * the exact shape `index()` consumes.
 *
 * @example
 * const kb = ai.rag({ embedder, store });
 * await kb.index(loadHtml(rawHtmlString, { id: "landing-page" }));
 *
 * @param html - The raw HTML markup.
 * @param options - Shared `id` / `metadata` / `tags` ({@link LoadHtmlOptions}).
 * @returns A {@link RagLoaderResult} (one document) ready for `rag.index()`.
 */
export function loadHtml(
  html: string,
  options: LoadHtmlOptions = {},
): RagLoaderResult {
  const id = options.id ?? DEFAULT_ID;
  const title = extractTitle(html);
  const text = htmlToText(html);

  // An all-markup / empty page strips to nothing; emit no document so
  // index() never receives a no-op record (matches loadText's behavior).
  if (text.length === 0) {
    return [];
  }

  // Derived keys (source, loader, title) sit UNDER the caller's metadata so
  // an explicit override always wins.
  const doc: RagDocument = {
    id,
    text,
    metadata: {
      source: id,
      loader: "html",
      ...(title !== undefined ? { title } : {}),
      ...options.metadata,
    },
    tags: options.tags,
  };

  return [doc];
}

/** Internal — exported for the web loader so it shares the exact strip pass. */
export { htmlToText, extractTitle };
