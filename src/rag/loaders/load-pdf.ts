import type { RagDocument } from "../contracts/rag-document.type";
import { PDF_PARSE_INSTALL_INSTRUCTIONS } from "./errors";
import type { LoadPdfOptions, RagLoaderResult } from "./loader.type";

/** Default `id` when the caller supplies none. */
const DEFAULT_ID = "document";

/**
 * The slice of `pdf-parse`'s result we consume. The peer returns more
 * (`info`, `metadata`, `version`); we only need the extracted `text` and
 * page count, so we type just those to keep the dependency at arm's length.
 */
type PdfParseResult = {
  /** Concatenated text of every page. */
  text: string;
  /** Number of pages in the document. */
  numpages: number;
  /** Document info dictionary — `Title` lifted into metadata when present. */
  info?: { Title?: string } & Record<string, unknown>;
};

/** The `pdf-parse` module's callable default export. */
type PdfParseFn = (
  data: Buffer | Uint8Array,
  options?: {
    /**
     * Per-page renderer `pdf-parse` calls once per page in document order and
     * `await`s — may return the page text synchronously or as a promise.
     */
    pagerender?: (page: unknown) => string | Promise<string>;
  },
) => Promise<PdfParseResult>;

// ============================================================
// Lazily-loaded pdf-parse (OPTIONAL peer)
// ============================================================

let pdfParse: PdfParseFn | undefined;
let isModuleExists: boolean | undefined;
let loadingPromise: Promise<void> | undefined;

/**
 * Settle the lazy import of `pdf-parse` once, concurrency-safe. A bare
 * `catch` flips the flag to `false`; the curated
 * {@link PDF_PARSE_INSTALL_INSTRUCTIONS} surfaces at first
 * {@link loadPdf} call, never a raw module-resolution stack trace. Mirrors
 * the guard moderation detector's `loadOpenAi`.
 */
function loadPdfParse(): Promise<void> {
  if (isModuleExists !== undefined) {
    return Promise.resolve();
  }

  if (loadingPromise) {
    return loadingPromise;
  }

  loadingPromise = (async () => {
    try {
      // Literal specifier so `vi.mock("pdf-parse")` can intercept it in tests.
      // Typed via the ambient `pdf-parse` shim in this directory, so the bare
      // import resolves even though the OPTIONAL peer is not a dependency.
      const mod = (await import("pdf-parse")) as {
        default?: PdfParseFn;
      } & Partial<PdfParseFn>;
      // pdf-parse ships CommonJS — the callable is `module.exports`, surfaced
      // as `default` under ESM interop. Fall back to the namespace itself for
      // bundlers that hoist the callable to the top level.
      pdfParse = mod.default ?? (mod as unknown as PdfParseFn);
      isModuleExists = typeof pdfParse === "function";
    } catch {
      isModuleExists = false;
    }
  })();

  return loadingPromise;
}

/**
 * Coerce a {@link RagDocument}-compatible binary input into a `Buffer` for
 * `pdf-parse`. Accepts a Node `Buffer`, an `ArrayBuffer`, or a typed array
 * (`Uint8Array`) — the shapes a file read / fetch body hands back.
 */
function toBuffer(input: Buffer | ArrayBuffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(input)) {
    return input;
  }

  if (input instanceof ArrayBuffer) {
    return Buffer.from(input);
  }

  return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

/**
 * Load a PDF's bytes into {@link RagDocument}(s) via the OPTIONAL `pdf-parse`
 * peer. The peer is resolved lazily on the FIRST call (not at import) so
 * importing `@warlock.js/ai` never forces it to be installed; when it is
 * absent the curated {@link PDF_PARSE_INSTALL_INSTRUCTIONS} is thrown as a
 * plain `Error` (a missing optional peer is an infrastructure fault, not a
 * content problem).
 *
 * By default the whole PDF becomes a single document carrying
 * `metadata.pageCount`. With `perPage: true`, each page becomes its own
 * document (`id` suffixed `#p<n>`, `metadata.page` set) so citations stay
 * page-precise. Document `metadata.title` comes from the PDF info
 * dictionary's `Title` (unless overridden), and `metadata.loader` is
 * `"pdf"`. The output is the exact shape `index()` consumes.
 *
 * @example
 * import { readFile } from "node:fs/promises";
 * const kb = ai.rag({ embedder, store });
 * await kb.index(await loadPdf(await readFile("guide.pdf"), { id: "guide" }));
 *
 * @example
 * // One document per page for page-precise citations:
 * await kb.index(await loadPdf(bytes, { id: "manual", perPage: true }));
 *
 * @param input - The PDF bytes (`Buffer`, `ArrayBuffer`, or `Uint8Array`).
 * @param options - `perPage` plus shared `id` / `metadata` / `tags`
 *   ({@link LoadPdfOptions}).
 * @returns A {@link RagLoaderResult} ready for `rag.index()`.
 * @throws {Error} carrying {@link PDF_PARSE_INSTALL_INSTRUCTIONS} when the
 *   `pdf-parse` peer is not installed.
 */
export async function loadPdf(
  input: Buffer | ArrayBuffer | Uint8Array,
  options: LoadPdfOptions = {},
): Promise<RagLoaderResult> {
  await loadPdfParse();

  if (!isModuleExists || !pdfParse) {
    throw new Error(PDF_PARSE_INSTALL_INSTRUCTIONS);
  }

  const id = options.id ?? DEFAULT_ID;
  const perPage = options.perPage ?? false;

  if (perPage) {
    return loadPerPage(input, id, options);
  }

  const parsed = await pdfParse(toBuffer(input));
  const text = parsed.text.trim();
  const title = parsed.info?.Title?.trim();

  // An image-only / empty PDF extracts no text — emit nothing so index()
  // never receives a no-op record.
  if (text.length === 0) {
    return [];
  }

  const doc: RagDocument = {
    id,
    text,
    metadata: {
      source: id,
      loader: "pdf",
      pageCount: parsed.numpages,
      ...(title ? { title } : {}),
      ...options.metadata,
    },
    tags: options.tags,
  };

  return [doc];
}

/** One page of a parsed PDF — the text-layer item list `pagerender` sees. */
type PdfPage = {
  getTextContent: (
    options?: unknown,
  ) => Promise<{ items: { str: string }[] }>;
};

/**
 * Per-page variant: render each page separately via `pdf-parse`'s
 * `pagerender` hook, accumulating one document per non-empty page. Each
 * carries `metadata.page` (1-based) and `metadata.pageCount`, and its id is
 * the base id suffixed `#p<n>` so every page-document is distinctly
 * identified for citation.
 *
 * `pdf-parse` calls `pagerender` once per page in document order and
 * `await`s the returned string, so capturing each page's joined text content
 * here gives reliable page boundaries the concatenated `text` lacks.
 */
async function loadPerPage(
  input: Buffer | ArrayBuffer | Uint8Array,
  id: string,
  options: LoadPdfOptions,
): Promise<RagDocument[]> {
  const pages: string[] = [];

  const parsed = await pdfParse!(toBuffer(input), {
    pagerender: async (page: unknown): Promise<string> => {
      const rendered = await renderPage(page as PdfPage);
      pages.push(rendered);
      return rendered;
    },
  });

  const title = parsed.info?.Title?.trim();
  const docs: RagDocument[] = [];

  pages.forEach((pageText, index) => {
    const text = pageText.trim();

    if (text.length === 0) {
      return;
    }

    const pageNumber = index + 1;

    docs.push({
      id: `${id}#p${pageNumber}`,
      text,
      metadata: {
        source: id,
        loader: "pdf",
        page: pageNumber,
        pageCount: parsed.numpages,
        ...(title ? { title } : {}),
        ...options.metadata,
      },
      tags: options.tags,
    });
  });

  return docs;
}

/**
 * Join a single page's text-layer items in reading order, inserting a space
 * between items so adjacent words do not run together. Mirrors the essence
 * of `pdf-parse`'s default renderer without depending on its internals, so
 * the per-page hook stays stable across `pdf-parse` versions. A page with no
 * text layer (scanned image) renders to an empty string and is dropped.
 */
async function renderPage(page: PdfPage): Promise<string> {
  if (typeof page?.getTextContent !== "function") {
    return "";
  }

  const content = await page.getTextContent({
    normalizeWhitespace: true,
    disableCombineTextItems: false,
  });

  return content.items
    .map((item) => item.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
