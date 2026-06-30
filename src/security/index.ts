/**
 * Shared security foundation (audit Phase 1). One `OutboundPolicy` + one
 * `redact()` utility consumed by every trust-boundary surface — attachment
 * ingestion (S1), URL skill sources (S3), error/cause serialization (S4),
 * VCR cassettes (S2), Panoptic content capture, and future RAG loaders
 * (A4) — instead of six isolated guards.
 */
export type {
  OutboundPolicy,
  ResolvedOutboundPolicy,
} from "./outbound-policy.type";
export {
  assertUrlAllowed,
  fetchTextWithPolicy,
  guardedFetch,
  readTextCapped,
  resolveOutboundPolicy,
} from "./outbound-policy";
export { isPrivateOrReservedIp } from "./private-ip";
export {
  DEFAULT_SENSITIVE_KEYS,
  redact,
  redactError,
  redactHeaders,
  scrubSecrets,
  SENSITIVE_HEADERS,
  type RedactedError,
  type RedactOptions,
} from "./redact";
