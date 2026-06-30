import { AIError, type AIErrorOptions } from "./ai-error";
import type { ErrorCategory } from "./error-category.type";

/**
 * A server-side outbound request (attachment fetch, URL skill manifest,
 * RAG loader, …) was blocked by the shared `OutboundPolicy` before it
 * left the process — a disallowed scheme, a host outside the allowlist, a
 * private / loopback / link-local / cloud-metadata address resolved after
 * DNS, an oversized body, or a timeout.
 *
 * This is the framework's SSRF / resource-exhaustion guard surfacing: the
 * request was refused on purpose, not a provider failure. `context`
 * carries the offending `url` / `host` / `reason` for logs.
 *
 * @example
 * if (error instanceof OutboundPolicyError) {
 *   logger.warn("blocked outbound fetch", { context: error.context });
 * }
 */
export class OutboundPolicyError extends AIError {
  public static readonly defaultCategory: ErrorCategory = "validation";

  public constructor(message: string, options?: AIErrorOptions) {
    super("OUTBOUND_POLICY_BLOCKED", message, options);
    this.name = "OutboundPolicyError";
  }
}
