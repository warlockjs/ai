/**
 * Parse a JSON string, returning a caller-supplied fallback when the input
 * is empty or malformed instead of throwing. Useful at provider boundaries
 * where tool-call arguments may arrive as `null`, `""`, or partial JSON
 * during streaming — callers want a safe default, not an exception.
 *
 * @example
 * const args = safeJsonParse<Record<string, unknown>>(toolCall.function.arguments, {});
 */
export function safeJsonParse<TValue>(
  data: string | null | undefined,
  defaultValue: TValue,
): TValue {
  if (!data) {
    return defaultValue;
  }

  try {
    return JSON.parse(data) as TValue;
  } catch {
    return defaultValue;
  }
}
