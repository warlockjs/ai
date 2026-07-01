/**
 * Document loaders for the RAG pipeline — the "#1 thing teams reach for".
 *
 * Each loader turns a source (a string, raw HTML, a URL, or PDF bytes) into
 * the EXACT {@link RagDocument} shape `ai.rag(config).index()` consumes, so a
 * load feeds straight in with no adapter:
 *
 * @example
 * import { ai } from "@warlock.js/ai";
 *
 * const kb = ai.rag({ embedder, store });
 * await kb.index(await loadWeb("https://example.com/guide"));
 * await kb.index(loadHtml(rawHtml, { id: "page" }));
 * await kb.index(loadText("plain notes…"));
 * await kb.index(await loadPdf(pdfBytes, { id: "manual", perPage: true }));
 *
 * Design notes:
 * - **No heavy deps.** `loadText` / `loadHtml` are zero-dependency; the HTML
 *   strip is a careful regex pass + entity decode, not a DOM parser.
 * - **SSRF-safe web fetch.** `loadWeb` NEVER issues a raw `fetch` — every
 *   request goes through the security module's `guardedFetch` /
 *   `OutboundPolicy` (scheme + host allowlist, post-DNS private-IP guard,
 *   timeout, body-size cap).
 * - **PDF is a lazy optional peer.** `loadPdf` dynamic-imports `pdf-parse`
 *   only on first use and throws curated install instructions when it is
 *   absent — importing `@warlock.js/ai` never forces the peer.
 *
 * Wired into `ai.rag.*` and the package barrel separately; this file owns
 * only the loaders' own exports.
 */

// Loaders
export { loadText, type TextInput } from "./load-text";
export { loadHtml } from "./load-html";
export { loadWeb } from "./load-web";
export { loadPdf } from "./load-pdf";

// Shared types
export type {
  RagLoaderResult,
  RagLoaderMetadata,
  RagLoaderType,
  RagLoaderOptions,
  LoadTextOptions,
  LoadHtmlOptions,
  LoadWebOptions,
  LoadPdfOptions,
} from "./loader.type";

// Missing-peer install string (for tests / callers that want to match it).
export { PDF_PARSE_INSTALL_INSTRUCTIONS } from "./errors";
