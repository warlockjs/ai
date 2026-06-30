import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { OutboundPolicyError } from "../errors";
import { isPrivateOrReservedIp } from "./private-ip";
import type {
  OutboundPolicy,
  ResolvedOutboundPolicy,
} from "./outbound-policy.type";

/** 5 MiB — default cap on an outbound response body. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
/** 10s — default per-request timeout. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Fill an {@link OutboundPolicy} with strict defaults: https-only,
 * private-IP deny on, 10s timeout, 5 MiB cap, global `fetch`. Idempotent
 * — resolving an already-resolved policy yields the same shape.
 */
export function resolveOutboundPolicy(
  policy: OutboundPolicy = {},
): ResolvedOutboundPolicy {
  return {
    allowedSchemes: policy.allowedSchemes ?? ["https"],
    hostAllowlist: policy.hostAllowlist,
    denyPrivateIPsAfterDNS: policy.denyPrivateIPsAfterDNS ?? true,
    maxBytes: policy.maxBytes ?? DEFAULT_MAX_BYTES,
    timeoutMs: policy.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: policy.signal,
    fetch: policy.fetch ?? globalThis.fetch,
  };
}

/** Strip the `[ ]` IPv6 brackets `URL.hostname` keeps. */
function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** Whether `host` equals or is a subdomain of any allowlist entry. */
function hostAllowed(host: string, allowlist: string[]): boolean {
  const lower = host.toLowerCase();
  return allowlist.some(entry => {
    const e = entry.toLowerCase();
    return lower === e || lower.endsWith(`.${e}`);
  });
}

/**
 * Validate a URL against the policy BEFORE any network call: scheme
 * allowlist, host allowlist, and (when enabled) a DNS resolution that
 * rejects private / loopback / link-local / metadata addresses — the SSRF
 * guard. Returns the parsed `URL` on success; throws
 * {@link OutboundPolicyError} otherwise.
 */
export async function assertUrlAllowed(
  rawUrl: string,
  policy: ResolvedOutboundPolicy,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OutboundPolicyError(`outbound request blocked — invalid URL: ${rawUrl}`, {
      context: { url: rawUrl },
    });
  }

  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (!policy.allowedSchemes.some(s => s.toLowerCase() === scheme)) {
    throw new OutboundPolicyError(
      `outbound request blocked — scheme "${scheme}" is not allowed (allowed: ${policy.allowedSchemes.join(", ")})`,
      { context: { url: rawUrl, scheme } },
    );
  }

  const host = stripBrackets(url.hostname);

  if (policy.hostAllowlist && !hostAllowed(host, policy.hostAllowlist)) {
    throw new OutboundPolicyError(
      `outbound request blocked — host "${host}" is not in the allowlist`,
      { context: { url: rawUrl, host } },
    );
  }

  if (policy.denyPrivateIPsAfterDNS) {
    await assertHostNotPrivate(host, rawUrl);
  }

  return url;
}

/**
 * Reject when `host` is — or resolves to — a private / reserved address.
 * IP literals are checked directly; hostnames are resolved via DNS and
 * every returned address is checked (a public name pointing inward is
 * caught). A resolution failure fails closed.
 */
async function assertHostNotPrivate(host: string, rawUrl: string): Promise<void> {
  if (isIP(host) !== 0) {
    if (isPrivateOrReservedIp(host)) {
      throw new OutboundPolicyError(
        `outbound request blocked — "${host}" is a private/reserved address`,
        { context: { url: rawUrl, address: host } },
      );
    }
    return;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch (cause) {
    throw new OutboundPolicyError(
      `outbound request blocked — could not resolve host "${host}" to verify it is public`,
      { cause, context: { url: rawUrl, host } },
    );
  }

  for (const { address } of addresses) {
    if (isPrivateOrReservedIp(address)) {
      throw new OutboundPolicyError(
        `outbound request blocked — host "${host}" resolves to a private/reserved address (${address})`,
        { context: { url: rawUrl, host, address } },
      );
    }
  }
}

/** Merge the internal timeout signal with an optional caller signal. */
function mergeSignals(
  timeout: AbortSignal,
  external?: AbortSignal,
): AbortSignal {
  if (!external) return timeout;

  const controller = new AbortController();
  const abort = (from: AbortSignal) => controller.abort(from.reason);

  if (timeout.aborted) abort(timeout);
  else timeout.addEventListener("abort", () => abort(timeout), { once: true });

  if (external.aborted) abort(external);
  else external.addEventListener("abort", () => abort(external), { once: true });

  return controller.signal;
}

/**
 * Policy-guarded `fetch`: validates the URL ({@link assertUrlAllowed}),
 * then performs the request with the policy's timeout and (optional)
 * caller signal merged. Returns the raw `Response` — read its body via
 * {@link readTextCapped} to enforce `maxBytes`. Throws
 * {@link OutboundPolicyError} on a policy violation or timeout.
 */
export async function guardedFetch(
  rawUrl: string,
  policyInput: OutboundPolicy,
  init?: RequestInit,
): Promise<Response> {
  const policy = resolveOutboundPolicy(policyInput);
  const url = await assertUrlAllowed(rawUrl, policy);

  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort(
      new OutboundPolicyError(
        `outbound request timed out after ${policy.timeoutMs}ms`,
        { context: { url: rawUrl, timeoutMs: policy.timeoutMs } },
      ),
    );
  }, policy.timeoutMs);

  try {
    return await policy.fetch(url, {
      ...init,
      signal: mergeSignals(timeoutController.signal, policy.signal),
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a response body as UTF-8 text with a hard byte cap. A declared
 * `content-length` over the cap fails fast; otherwise the stream is read
 * chunk-by-chunk and aborted the moment the running total exceeds
 * `maxBytes`. Throws {@link OutboundPolicyError} on overflow.
 */
export async function readTextCapped(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new OutboundPolicyError(
      `outbound response body too large — declared ${declared} bytes exceeds the ${maxBytes}-byte cap`,
      { context: { declared, maxBytes } },
    );
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new OutboundPolicyError(
        `outbound response body exceeded the ${maxBytes}-byte cap`,
        { context: { maxBytes } },
      );
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new OutboundPolicyError(
        `outbound response body exceeded the ${maxBytes}-byte cap`,
        { context: { maxBytes } },
      );
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Convenience: {@link guardedFetch} + {@link readTextCapped}. Returns the
 * response status alongside the (capped) body text so callers can shape
 * their own not-OK error. The body is only read when the response is OK.
 */
export async function fetchTextWithPolicy(
  rawUrl: string,
  policyInput: OutboundPolicy,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; statusText: string; text: string }> {
  const policy = resolveOutboundPolicy(policyInput);
  const response = await guardedFetch(rawUrl, policy, init);

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    text: response.ok ? await readTextCapped(response, policy.maxBytes) : "",
  };
}
