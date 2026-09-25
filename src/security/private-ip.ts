/**
 * Compatibility export for the shared core SSRF classifier. Keeping this
 * AI-facing path avoids a breaking change for existing consumers while both
 * AI outbound policy checks and core storage checks use identical IP rules.
 */
export { isPrivateOrReservedIp } from "@warlock.js/core";
