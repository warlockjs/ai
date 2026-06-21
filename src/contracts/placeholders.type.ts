/**
 * A map of placeholder keys to their replacement values.
 * Supports nested access via dot notation in {{mustache}} templates.
 *
 * Syntax:
 * - `{{key}}` — simple replacement
 * - `{{ctx.city}}` — nested access
 * - `{{lang|English}}` — with default value
 *
 * @example
 * const placeholders: Placeholders = {
 *   name: "Hasan",
 *   ctx: { city: "Cairo", country: "Egypt" },
 *   lang: "Arabic",
 * };
 * // Template: "Hello {{name}}, welcome from {{ctx.city}}. Language: {{lang|English}}"
 * // Resolved: "Hello Hasan, welcome from Cairo. Language: Arabic"
 */
export type Placeholders = Record<string, unknown>;
