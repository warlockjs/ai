/**
 * Best-effort parse of a possibly-truncated JSON string into the value it
 * is "on its way to" becoming. Used by {@link streamObject} to emit a
 * partial object snapshot from each streamed delta before the full reply
 * has arrived.
 *
 * Returns `undefined` when the prefix can't yet be coerced into a value
 * (so the caller simply waits for more text). The FINAL parse in
 * `streamObject` is always strict `JSON.parse` — this tolerant parser only
 * powers the in-flight snapshots, so a too-clever completion never affects
 * the authoritative result.
 *
 * @example
 * parsePartialJson('{"name":"Al');      // → { name: "Al" }
 * parsePartialJson('{"items":[1,2,');   // → { items: [1, 2] }
 * parsePartialJson('{"a":1,"b"');       // → { a: 1 } (drops the dangling key)
 */
export function parsePartialJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  // Fast path: already-valid JSON.
  const direct = tryParse(trimmed);
  if (direct.ok) return direct.value;

  const completed = completePartialJson(trimmed);
  if (completed === undefined) return undefined;

  const parsed = tryParse(completed);
  return parsed.ok ? parsed.value : undefined;
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Reconstruct a parseable JSON string from a truncated prefix by closing
 * open strings/containers and trimming dangling separators, keys, and
 * partial literals. Tries the most faithful completion first, then falls
 * back to dropping the unfinished tail.
 */
function completePartialJson(text: string): string | undefined {
  const stack: Array<"{" | "["> = [];
  let inString = false;
  let escaped = false;

  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }

  const closers = () =>
    stack
      .map(c => (c === "{" ? "}" : "]"))
      .reverse()
      .join("");

  // Faithful completion: close an open string, drop a trailing comma,
  // fill a dangling `key:` with null, then close containers.
  let core = text;
  if (inString) core += '"';
  core = core.replace(/\s+$/, "");
  if (core.endsWith(",")) core = core.slice(0, -1);
  if (core.endsWith(":")) core += "null";

  const attempts: string[] = [core + closers()];

  // Fallback 1: drop a dangling object key (a `"..."` with no value yet).
  if (stack[stack.length - 1] === "{") {
    const droppedKey = core.replace(/,?\s*"(?:[^"\\]|\\.)*"\s*$/, "");
    attempts.push(droppedKey.replace(/,\s*$/, "") + closers());
  }

  // Fallback 2: drop a partial trailing literal / number (e.g. `tr`, `12.`).
  const droppedLiteral = core.replace(/[:,]?\s*[A-Za-z0-9.+\-eE]+$/, match =>
    match.trimStart().startsWith(":") ? ":null" : "",
  );
  attempts.push(droppedLiteral.replace(/,\s*$/, "") + closers());

  for (const candidate of attempts) {
    if (tryParse(candidate).ok) return candidate;
  }

  return undefined;
}
