---
name: secure-outbound-requests
description: 'The shared SSRF / resource-exhaustion guard every server-side outbound HTTP request in the framework goes through — `guardedFetch(url, policy, init?)`, `OutboundPolicy`, `assertUrlAllowed`, `fetchTextWithPolicy`, `readTextCapped`. Scheme allowlist (https-only default), host allowlist, post-DNS private/loopback/link-local/metadata-address deny, byte cap, timeout, and (4.15.0) per-hop redirect revalidation with a `maxRedirects` cap and cross-origin credential stripping. Consumed by `ai.rag.loadWeb`, remote text attachments (`prepareAttachmentPart`), and the skills `urlSource` manifest fetch — never a raw `fetch()` on a caller-influenced URL. Triggers: `guardedFetch`, `OutboundPolicy`, `ResolvedOutboundPolicy`, `assertUrlAllowed`, `fetchTextWithPolicy`, `readTextCapped`, `resolveOutboundPolicy`, `OutboundPolicyError`, `maxRedirects`, `denyPrivateIPsAfterDNS`, `hostAllowlist`, `allowedSchemes`, `maxBytes`, `SSRF`, `redirect: "manual"`, `redirect: "error"`; ''SSRF-safe fetch'', ''block a redirect into a private IP'', ''fetch a URL an agent gave me'', ''cap outbound response size'', ''allowlist hosts for outbound requests'', ''strip auth headers on a cross-origin redirect''; typical import `import { guardedFetch, assertUrlAllowed } from "@warlock.js/ai"` (also re-exported per call site). Skip: the RAG loader that wraps this for `loadWeb` — `@warlock.js/ai/rag-loaders-and-stores/SKILL.md`; the skills manifest source that wraps this for `urlSource` — `@warlock.js/ai/use-runtime-skills/SKILL.md`; prompt-injection / content guardrails (a different trust boundary) — `@warlock.js/ai/guard-input-output/SKILL.md` (ai-guard package).'
---

# Outbound request policy — the SSRF guard

One `OutboundPolicy` + `guardedFetch` backs **every** server-side HTTP request the framework makes on behalf of user/model-controlled input: `ai.rag.loadWeb`, the remote-text branch of `prepareAttachmentPart` (agent `attachments`), and the skills catalog `urlSource` manifest fetch. A single audited guard instead of N ad-hoc `fetch()` call sites.

```ts
import { guardedFetch, fetchTextWithPolicy, assertUrlAllowed, OutboundPolicyError } from "@warlock.js/ai";

const response = await guardedFetch("https://docs.example.com/page", {
  hostAllowlist: ["docs.example.com"],
  maxBytes: 2_000_000,
  timeoutMs: 5_000,
});
```

## Strict-by-default policy

Every field is optional; `resolveOutboundPolicy` fills safe defaults, so an untuned call is already hardened:

| Field | Default | Guards against |
| --- | --- | --- |
| `allowedSchemes` | `["https"]` | plaintext / `file:` / `data:` exfil — `http` must be opted in |
| `hostAllowlist` | unset (any host) | pinning outbound targets to known hosts, e.g. `docs.example.com` allows `a.docs.example.com` |
| `denyPrivateIPsAfterDNS` | `true` | **the SSRF guard itself** — resolves the host through DNS and rejects loopback / private / link-local / unique-local / cloud-metadata (`169.254.169.254`) addresses; a public hostname that resolves inward is caught |
| `maxRedirects` | `5` | a redirect chain used to bypass the checks above (4.15.0 — see below) |
| `maxBytes` | `5_242_880` (5 MiB) | unbounded response bodies |
| `timeoutMs` | `10_000` | a hung/slow endpoint tying up the request |
| `signal` | unset | caller-supplied `AbortSignal`, merged with the internal timeout |
| `fetch` | global `fetch` | inject a stub for tests, or a wrapper enforcing your own app-level rules |

Every violation throws `OutboundPolicyError` with `context` carrying the offending URL/host/address — never a silent fallback.

## Redirects are never delegated to the platform (4.15.0)

Before 4.15.0, `assertUrlAllowed` validated only the *initial* URL, then handed the request to `fetch` with automatic redirect following — so a URL that passed validation could `3xx` into a private/metadata address or an off-allowlist host with no re-check.

`guardedFetch` now issues **every hop** with `redirect: "manual"` and re-runs the `Location` header through the exact same `assertUrlAllowed` (scheme, host allowlist, post-DNS private-IP deny) before following it:

- Capped at `policy.maxRedirects` (default `5`) — the `(maxRedirects + 1)`th hop throws `OutboundPolicyError`.
- **Credential headers stripped cross-origin.** `authorization`, `cookie`, `proxy-authorization` are dropped the moment a hop's target origin differs from the current one — a redirect can't exfiltrate credentials meant for the original host.
- **Method/body semantics match platform behavior.** `303` — and the legacy convention of `301`/`302` on a non-`GET`/`HEAD` method — re-issue the next hop as a bodyless `GET`.
- Pass `init.redirect: "manual"` to get the raw 3xx response back (no following, no throw); `init.redirect: "error"` rejects on any redirect.
- The net effect: a redirect can never reach a URL the original request could not have reached directly.

```ts
// A caller that wants to inspect redirects itself, unfollowed:
const res = await guardedFetch(url, policy, { redirect: "manual" });
if (res.status >= 300 && res.status < 400) {
  console.log(res.headers.get("location"));
}
```

## Reading the body — `readTextCapped` / `fetchTextWithPolicy`

`guardedFetch` returns the raw `Response`; read its body through `readTextCapped(response, maxBytes)` to enforce the cap (a declared `content-length` over the cap fails fast, otherwise the stream is read chunk-by-chunk and aborted the moment the running total exceeds it). `fetchTextWithPolicy(url, policy, init?)` is the one-call convenience — `guardedFetch` + `readTextCapped`, returning `{ ok, status, statusText, text }` (body only read when `ok`).

```ts
const { ok, status, text } = await fetchTextWithPolicy(url, { hostAllowlist: ["api.example.com"] });
if (!ok) throw new Error(`fetch failed: ${status}`);
```

## Who consumes this

| Call site | Entry point | Notes |
| --- | --- | --- |
| RAG web loader | `ai.rag.loadWeb(url, { policy })` | [`@warlock.js/ai/rag-loaders-and-stores/SKILL.md`](@warlock.js/ai/rag-loaders-and-stores/SKILL.md) |
| Remote text attachment | `prepareAttachmentPart` via `agent.execute({ attachments })` | default-DENY — requires `attachmentPolicy.allowRemoteFetch: true`; policy travels as `attachmentPolicy.outbound`. URL *image* attachments are handed to the provider as a URL and never fetched server-side, so they carry no SSRF surface here |
| Skills catalog manifest | `ai.skills({ sources: [urlSource(url, { policy })] })` | [`@warlock.js/ai/use-runtime-skills/SKILL.md`](@warlock.js/ai/use-runtime-skills/SKILL.md) — the fetched manifest is also runtime-validated record-by-record before being trusted |

Each call site passes its own `policy` (or `{}` for the strict defaults) — there is no global policy singleton, so tune per source (e.g. `hostAllowlist` for a known-good docs domain vs. an open web crawl).

## Testing

Inject a stubbed `policy.fetch` (`(url, init) => Response`) instead of hitting the network — every consumer above accepts `policy.fetch` all the way through. Regression coverage lives in `src/security/outbound-policy.spec.ts` (redirect-to-metadata/loopback/private block, off-allowlist redirect block, hop cap, credential stripping, clean-redirect follow).

## See also

- [`@warlock.js/ai/rag-loaders-and-stores/SKILL.md`](@warlock.js/ai/rag-loaders-and-stores/SKILL.md) — `loadWeb`, the primary consumer
- [`@warlock.js/ai/use-runtime-skills/SKILL.md`](@warlock.js/ai/use-runtime-skills/SKILL.md) — `urlSource`'s manifest fetch
- [`@warlock.js/ai/run-ai-agent/SKILL.md`](@warlock.js/ai/run-ai-agent/SKILL.md) — `attachments`, including the remote-text fetch path
- [`@warlock.js/ai/handle-ai-errors/SKILL.md`](@warlock.js/ai/handle-ai-errors/SKILL.md) — `OutboundPolicyError`
