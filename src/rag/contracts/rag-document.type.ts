/**
 * A raw document handed to the pipeline before chunking.
 *
 * The caller is responsible for loading documents (from files, a DB, an
 * API, …) and parsing them down to text — document loaders are out of
 * scope for v1. `index()` takes already-loaded `{ id, text }` documents.
 */
export type RagDocument = {
  /** Stable source id — propagated to every chunk + citation from this doc. */
  id: string;
  /** Full text to be chunked + embedded. */
  text: string;
  /** Opaque metadata round-tripped onto chunks + citations (url, title, page…). */
  metadata?: Record<string, unknown>;
  /**
   * Optional tags applied to every chunk written from this document, so
   * `retrieve({ tags })` can restrict retrieval to a subset of sources.
   */
  tags?: string[];
};
