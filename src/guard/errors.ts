/**
 * Error surface for `@warlock.js/ai`.
 *
 * **No new error class.** A `block` verdict reuses the existing
 * `@warlock.js/ai` {@link GuardrailViolationError} verbatim — its category
 * (`"guardrail"`) and `phase` field already model exactly what a guard
 * needs, and `phase` is widened by this package to include `"tool"` (a
 * source-compatible third value). Re-exported here so the future `guard()`
 * factory has one import site for the typed abort it throws.
 *
 * The optional `moderation` detector's missing-peer failure is an
 * *infrastructure* fault, not a content violation, so it throws a plain
 * `Error` carrying {@link OPENAI_INSTALL_INSTRUCTIONS} (the langfuse-style
 * lazy-import pattern) rather than an `AIError`.
 */
export { GuardrailViolationError } from "../errors/guardrail-violation-error";
export type { GuardrailViolationErrorOptions } from "../errors/guardrail-violation-error";

/**
 * Curated install string thrown by the optional `moderation` detector on
 * first `check()` when the `openai` peer is absent. Mirrors ai-panoptic's
 * `LANGFUSE_INSTALL_INSTRUCTIONS`.
 */
export const OPENAI_INSTALL_INSTRUCTIONS = `
The @warlock.js/ai moderation detector requires the optional "openai" peer.
Install it with:

  npm install openai
`.trim();
