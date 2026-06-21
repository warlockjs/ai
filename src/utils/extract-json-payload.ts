/**
 * Strip markdown code fences from an LLM response before JSON parsing.
 *
 * Models — especially Claude, smaller models, and local models — routinely
 * wrap JSON output in fenced code blocks (` ```json\n{...}\n``` `) even when
 * instructed otherwise. Sometimes they also precede the fence with prose
 * ("Here you go:\n```json\n...\n```"). This helper finds the first fenced
 * block regardless of language tag and returns its trimmed contents.
 *
 * Returns the trimmed original text unchanged when no fence is present, so
 * clean JSON passes through as a no-op.
 *
 * Deliberately does NOT fall back to "find first `{` and last `}` and slice
 * between them" — that heuristic silently corrupts data when prose contains
 * stray braces. Failing loudly at `JSON.parse` is safer.
 *
 * @example
 * extractJsonPayload('```json\n{"a":1}\n```');
 * // => '{"a":1}'
 *
 * @example
 * extractJsonPayload('Here you go:\n```\n{"a":1}\n```\nHope this helps.');
 * // => '{"a":1}'
 *
 * @example
 * extractJsonPayload('{"a":1}');
 * // => '{"a":1}'   (no fence → unchanged)
 */
export function extractJsonPayload(text: string): string {
  const trimmed = text.trim();

  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);

  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  return trimmed;
}
