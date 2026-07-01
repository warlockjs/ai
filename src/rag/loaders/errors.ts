/**
 * Loader error surface. The only loader-specific failure is a missing
 * OPTIONAL peer (`pdf-parse`), which — like the moderation detector's
 * missing `openai` peer — is an *infrastructure* fault, not a content
 * problem, so {@link loadPdf} throws a plain `Error` carrying the curated
 * {@link PDF_PARSE_INSTALL_INSTRUCTIONS} rather than an `AIError`. Mirrors
 * the guard's `OPENAI_INSTALL_INSTRUCTIONS` / ai-panoptic's
 * `LANGFUSE_INSTALL_INSTRUCTIONS`.
 */

/**
 * Curated install string thrown by {@link loadPdf} on first call when the
 * `pdf-parse` peer is absent. Surfaced instead of a raw
 * module-resolution stack trace.
 */
export const PDF_PARSE_INSTALL_INSTRUCTIONS = `
The @warlock.js/ai PDF loader requires the optional "pdf-parse" peer.
Install it with:

  npm install pdf-parse
`.trim();
