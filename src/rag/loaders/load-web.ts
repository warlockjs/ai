import {
  guardedFetch,
  readTextCapped,
  resolveOutboundPolicy,
} from "../../security/outbound-policy";
import { OutboundPolicyError } from "../../errors";
import type { RagDocument } from "../contracts/rag-document.type";
import { htmlToText, extractTitle } from "./load-html";
import type { LoadWebOptions, RagLoaderResult } from "./loader.type";

/** Browser-ish UA so servers that gate on it still return prose. */
const DEFAULT_USER_AGENT =
  "warlock-ai-rag-loader/1.0 (+https://github.com/warlock-js)";

/**
 * Whether a `content-type` header names an HTML document (so it is run
 * through the tag-strip pass) versus already-plain text (used verbatim).
 */
function isHtmlContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    // No header — assume HTML, the common case for a fetched URL.
    return true;
  }

  const lower = contentType.toLowerCase();

  return lower.includes("text/html") || lower.includes("application/xhtml");
}

/**
 * Fetch a URL through the SSRF-safe outbound policy and load it into a single
 * {@link RagDocument} of readable text. The fetch ALWAYS goes through
 * `guardedFetch` — never a raw `fetch` — so the scheme allowlist, host
 * allowlist, post-DNS private-IP guard, timeout, and response-size cap from
 * {@link LoadWebOptions.policy} (or the strict defaults) always apply.
 *
 * HTML responses are run through the same tag-strip pass as {@link loadHtml}
 * (scripts/styles dropped, entities decoded, paragraph structure kept);
 * non-HTML text responses (`text/plain`, markdown, …) are used verbatim.
 * The document's `metadata.source` is the resolved URL, `metadata.title` is
 * the page `<title>` (HTML only, unless overridden), `metadata.contentType`
 * is the server-reported type, and `metadata.loader` is `"web"`.
 *
 * The output is the exact shape `index()` consumes, so a load feeds straight
 * in:
 *
 * @example
 * const kb = ai.rag({ embedder, store });
 * await kb.index(await loadWeb("https://example.com/guide"));
 *
 * @example
 * // Tighten the SSRF policy to a single host:
 * await kb.index(await loadWeb(url, {
 *   policy: { hostAllowlist: ["docs.example.com"], maxBytes: 2_000_000 },
 *   tags: ["docs"],
 * }));
 *
 * @param url - The absolute URL to fetch. Validated by the outbound policy.
 * @param options - `policy` (the {@link OutboundPolicy}) plus shared
 *   `id` / `metadata` / `tags` ({@link LoadWebOptions}).
 * @returns A {@link RagLoaderResult} (one document) ready for `rag.index()`.
 * @throws {OutboundPolicyError} when the policy blocks the URL, the request
 *   times out, the body exceeds the cap, or the response is not OK.
 */
export async function loadWeb(
  url: string,
  options: LoadWebOptions = {},
): Promise<RagLoaderResult> {
  const policy = resolveOutboundPolicy(options.policy);

  const response = await guardedFetch(url, policy, {
    headers: { "user-agent": DEFAULT_USER_AGENT, accept: "text/html,text/*" },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new OutboundPolicyError(
      `loadWeb: fetching "${url}" returned ${response.status} ${response.statusText}`,
      { context: { url, status: response.status } },
    );
  }

  const contentType = response.headers.get("content-type") ?? undefined;
  const raw = await readTextCapped(response, policy.maxBytes);

  const isHtml = isHtmlContentType(contentType);
  const text = isHtml ? htmlToText(raw) : raw.trim();
  const title = isHtml ? extractTitle(raw) : undefined;

  const id = options.id ?? url;

  // An empty body / all-markup page yields no document, so index() never
  // receives a no-op record.
  if (text.length === 0) {
    return [];
  }

  // Derived keys sit UNDER the caller's metadata so an explicit override wins.
  const doc: RagDocument = {
    id,
    text,
    metadata: {
      source: url,
      loader: "web",
      ...(title !== undefined ? { title } : {}),
      ...(contentType !== undefined ? { contentType } : {}),
      ...options.metadata,
    },
    tags: options.tags,
  };

  return [doc];
}
