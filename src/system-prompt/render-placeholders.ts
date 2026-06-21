import type { Placeholders } from "../contracts/placeholders.type";

const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * Render a template string against a placeholders map, supporting dot-path
 * lookups and inline fallback values.
 *
 * Supported syntax:
 * - `{{key}}` — replaced by `placeholders.key`, left untouched if missing.
 * - `{{a.b.c}}` — dot-path lookup into nested objects.
 * - `{{key|default}}` — substitutes `default` when the key resolves to
 *   `undefined`, `null`, or empty string.
 *
 * Whitespace inside the braces is ignored (`{{ key }}` == `{{key}}`).
 * Values are coerced to strings via `String(value)`.
 *
 * @example
 * renderPlaceholders(
 *   "Hello {{user.name|friend}}, your role is {{role}}",
 *   { user: { name: "Hasan" }, role: "admin" },
 * );
 * // "Hello Hasan, your role is admin"
 *
 * @example
 * renderPlaceholders("Hello {{user.name|friend}}", {});
 * // "Hello friend"
 */
export function renderPlaceholders(
  template: string,
  placeholders: Placeholders = {},
): string {
  return template.replace(
    PLACEHOLDER_PATTERN,
    (match, rawExpression: string) => {
      const [rawPath, rawFallback] = rawExpression.split("|");
      const path = rawPath.trim();
      const fallback = rawFallback?.trim();

      const value = lookupPath(placeholders, path);

      if (value === undefined || value === null || value === "") {
        if (fallback !== undefined) {
          return fallback;
        }

        return match;
      }

      return String(value);
    },
  );
}

/**
 * Walk a dot-path (`"a.b.c"`) through an arbitrary record, returning the
 * leaf value or `undefined` when any segment is missing or blocks traversal
 * (non-object). Never throws.
 */
function lookupPath(source: Placeholders, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = source;

  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (typeof current !== "object") {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}
