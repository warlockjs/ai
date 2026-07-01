import type { RagDocument } from "../contracts/rag-document.type";
import type { OutboundPolicy } from "../../security/outbound-policy.type";

/**
 * The shape every loader emits — the **exact** {@link RagDocument} (or array
 * of them) that `ai.rag(config).index()` consumes, so a load result is fed
 * straight in with no adapter:
 *
 * @example
 * const kb = ai.rag({ embedder, store });
 * await kb.index(await ai.rag.loadWeb("https://example.com/guide"));
 *
 * A loader may emit one document (the common case for a single file / page)
 * or several (e.g. one document per PDF page), so the result is uniformly an
 * **array** — `index()` accepts an array, so callers never branch on arity.
 */
export type RagLoaderResult = RagDocument[];

/**
 * Metadata keys loaders attach to every {@link RagDocument} they emit, on
 * top of any caller-supplied `metadata`. Each is optional and only present
 * when the loader could determine it. These keys round-trip through
 * chunking onto the final citation, so a retrieved chunk can be traced back
 * to its `source` URL / `title` / `page`.
 */
export type RagLoaderMetadata = {
  /**
   * Where the document came from — a URL (web loader), a logical name, or
   * the caller-supplied `id`. Always a string when present.
   */
  source?: string;
  /** Human-readable title, e.g. an HTML `<title>` or PDF document title. */
  title?: string;
  /** Discriminator for the loader that produced the document. */
  loader?: RagLoaderType;
  /** 1-based page number — set by {@link loadPdf} on per-page documents. */
  page?: number;
  /** Total page count of the source — set by {@link loadPdf}. */
  pageCount?: number;
  /** MIME content-type reported by the server — set by the web loader. */
  contentType?: string;
};

/** Discriminator identifying which loader produced a {@link RagDocument}. */
export type RagLoaderType = "text" | "html" | "web" | "pdf";

/**
 * Shared options every loader accepts. The `id` and `metadata` flow onto
 * the emitted {@link RagDocument} verbatim (loader-derived metadata is
 * merged UNDER the caller's, so an explicit `metadata.title` always wins),
 * and `tags` propagate to every chunk for `retrieve({ tags })` filtering.
 */
export type RagLoaderOptions = {
  /**
   * Stable source id for the emitted document(s). Falls back to a
   * loader-specific default (the URL for the web loader, `"document"`
   * otherwise). Multi-document loaders suffix this (e.g. `"<id>#p3"`).
   */
  id?: string;
  /**
   * Extra metadata merged onto every emitted document. Caller keys take
   * precedence over the loader's derived keys (`source`, `title`, …).
   */
  metadata?: Record<string, unknown>;
  /** Tags applied to every chunk written from the emitted document(s). */
  tags?: string[];
};

/** Options for the HTML loader — {@link RagLoaderOptions} only. */
export type LoadHtmlOptions = RagLoaderOptions;

/** Options for the plain-text loader — {@link RagLoaderOptions} only. */
export type LoadTextOptions = RagLoaderOptions;

/** Options for the PDF loader. */
export type LoadPdfOptions = RagLoaderOptions & {
  /**
   * Emit one {@link RagDocument} per page (each tagged with `page` /
   * `pageCount` metadata) instead of a single concatenated document.
   * Per-page documents keep citations page-precise. Default `false`.
   */
  perPage?: boolean;
};

/**
 * Options for the web loader. Extends {@link RagLoaderOptions} with an
 * {@link OutboundPolicy} — the SSRF-safe fetch policy the loader hands to
 * `guardedFetch`. Omit it and the strict defaults apply (https-only,
 * private-IP deny on, 10s timeout, 5 MiB cap).
 */
export type LoadWebOptions = RagLoaderOptions & {
  /**
   * The {@link OutboundPolicy} governing the fetch. The web loader NEVER
   * issues a raw `fetch` — every request goes through the policy's
   * `guardedFetch`, so an SSRF / oversized-body guard always applies.
   */
  policy?: OutboundPolicy;
};
