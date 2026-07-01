/**
 * Minimal ambient declaration for the OPTIONAL `pdf-parse` peer.
 *
 * `pdf-parse` is a lazy, optional dependency — it is NOT in this package's
 * `dependencies`, so without this shim the literal `import("pdf-parse")` in
 * `load-pdf.ts` would fail type resolution (TS2307) on a machine that does
 * not have the peer installed. The shim types only the slice the loader
 * consumes (the callable parser + its `text` / `numpages` / `info` result),
 * mirroring how the other loaders keep their optional peers at arm's length.
 *
 * When the real `pdf-parse` (or its `@types`) is installed, that fuller
 * declaration is compatible with this narrower one, so the shim never
 * conflicts.
 */
declare module "pdf-parse" {
  /** The subset of `pdf-parse`'s result the loader reads. */
  interface PdfParseData {
    /** Concatenated text of every page. */
    text: string;
    /** Number of pages in the document. */
    numpages: number;
    /** Document info dictionary; `Title` is lifted into metadata when present. */
    info?: { Title?: string } & Record<string, unknown>;
  }

  /** Options accepted by the parser — only the per-page renderer is used. */
  interface PdfParseOptions {
    /**
     * Called once per page in document order; the returned (awaited) string
     * is the page's rendered text. Used by the per-page loader path.
     */
    pagerender?: (page: unknown) => string | Promise<string>;
  }

  /** The callable default export (`pdf-parse` is CommonJS). */
  function pdfParse(
    data: Buffer | Uint8Array,
    options?: PdfParseOptions,
  ): Promise<PdfParseData>;

  export = pdfParse;
}
