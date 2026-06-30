import { extractJsonPayload } from "./extract-json-payload";

/**
 * Lenient counterpart to {@link extractJsonPayload}, tuned for the
 * structured-output judges that emit *corrupted* JSON — notably the
 * Amazon Nova family, which routinely wraps its verdict in fenced
 * ` ```json ` blocks, prepends an explanation paragraph, or trails the
 * object with commentary.
 *
 * Where `extractJsonPayload` deliberately refuses the "first `{` … last
 * `}`" heuristic (it would corrupt strict callers when prose contains
 * stray braces), this helper *opts into* that resilience: after fence
 * stripping it scans for the first balanced JSON object (`{…}`) or array
 * (`[…]`) and returns just that slice. Brace/bracket counting is
 * string-aware (it ignores braces inside JSON string literals and honors
 * `\"` escapes), so prose-embedded braces inside the JSON's own strings
 * don't throw off the balance.
 *
 * Returns the fence-stripped, trimmed text unchanged when no balanced
 * structure is found, so the caller's `JSON.parse` still fails loudly on
 * genuine garbage rather than this helper inventing a value.
 *
 * **Trade-off:** resilience over strictness. Use it only where a tolerant
 * parse is wanted (the judge preset) — for normal structured output keep
 * `extractJsonPayload`, which fails fast on malformed responses so real
 * prompt/model defects surface instead of being silently papered over.
 *
 * @example
 * extractJsonLenient('Here is my verdict:\n```json\n{"score":0.9}\n``` — done.');
 * // => '{"score":0.9}'
 *
 * @example
 * extractJsonLenient('The answer is {"verdict":"pass"} for sure.');
 * // => '{"verdict":"pass"}'
 *
 * @example
 * extractJsonLenient('{"valid":true}');
 * // => '{"valid":true}'   (clean JSON passes through)
 */
export function extractJsonLenient(text: string): string {
  // First reuse the strict fence stripper. When the model produced a
  // clean fenced block this already yields the exact payload, so the
  // balanced scan below becomes a no-op pass-through.
  const stripped = extractJsonPayload(text);

  const sliced = sliceFirstBalanced(stripped);

  return sliced ?? stripped;
}

/**
 * Scan for the first balanced JSON object or array and return its raw
 * slice. Returns `undefined` when no opening `{`/`[` is found or the
 * structure never closes (truncated / partial output) — the caller then
 * falls back to the fence-stripped text so the failure stays visible.
 *
 * String-literal aware: braces and brackets appearing *inside* a JSON
 * string are not counted toward the balance, and a backslash escapes the
 * next character so an escaped quote (`\"`) doesn't prematurely end the
 * string scan.
 */
function sliceFirstBalanced(text: string): string | undefined {
  const start = firstOpenerIndex(text);

  if (start === -1) {
    return undefined;
  }

  const opener = text[start];
  const closer = opener === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index++) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === opener) {
      depth++;
    } else if (char === closer) {
      depth--;

      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  // Opener with no matching close — truncated / partial output. Leave it
  // to the caller's fallback (and its loud parse failure).
  return undefined;
}

/**
 * Index of the first JSON structure opener (`{` or `[`), whichever
 * appears earliest, or `-1` when neither is present.
 */
function firstOpenerIndex(text: string): number {
  const brace = text.indexOf("{");
  const bracket = text.indexOf("[");

  if (brace === -1) {
    return bracket;
  }

  if (bracket === -1) {
    return brace;
  }

  return Math.min(brace, bracket);
}
