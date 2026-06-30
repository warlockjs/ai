import type { OutboundPolicy } from "../security/outbound-policy.type";

/**
 * Trust-boundary policy for agent attachments (S1). Attachment references
 * are frequently user-controlled (chat uploads, document-ingestion
 * endpoints), so the framework treats server-side fetches and local reads
 * as hostile by default.
 *
 * Supply it on `AgentConfig.attachmentPolicy` (factory default) or
 * per-call `AgentExecuteOptions.attachmentPolicy` (overrides the factory
 * one). Omitting it keeps the safe defaults: remote text fetch is denied,
 * and bare-string local paths warn (staged deprecation).
 */
export type AttachmentPolicy = {
  /**
   * Allow fetching a REMOTE TEXT attachment (an `http`/`https` URL given
   * as a `{ type: "text" }` source). Default `false` — default-deny: such
   * a fetch throws `OutboundPolicyError` unless this is enabled.
   *
   * URL *image* attachments are handed to the provider as a URL and are
   * never fetched server-side, so they are unaffected by this flag.
   */
  allowRemoteFetch?: boolean;
  /**
   * {@link OutboundPolicy} applied to a permitted remote-text fetch
   * (scheme + host allowlist, post-DNS private-IP deny, max bytes,
   * timeout, injectable fetch). Defaults to the strict OutboundPolicy
   * defaults (https-only, private-IP deny on, 5 MiB cap, 10s timeout).
   */
  outbound?: OutboundPolicy;
  /**
   * Sandbox roots for LOCAL file attachments. When set, a local path must
   * resolve inside one of these absolute roots, else it is rejected with
   * `OutboundPolicyError`. When omitted, local reads are not path-
   * restricted (back-compat) — set this to confine reads to an uploads
   * directory.
   */
  allowedRoots?: string[];
  /**
   * Allow bare-STRING local paths (e.g. `"./notes.txt"`, `"/etc/passwd"`).
   * Staged deprecation: today bare-string local paths are allowed but warn
   * once (outside tests). Set `false` to hard-deny them now — the typed
   * `{ type, source: { absolutePath } }` StorageFile route stays supported
   * (and is gated by {@link allowedRoots}).
   */
  allowBareLocalPaths?: boolean;
};
