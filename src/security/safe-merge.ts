/**
 * Prototype-key guard for merges of model-influenced data into plain
 * objects (supervisor `state`, artifact bags, refine slices, …).
 *
 * Any `target[key] = value` where `key` came from an LLM, a tool
 * result, or a permissively-schema'd agent output is a prototype-
 * tampering primitive: `state["__proto__"] = {...}` repoints that
 * object's prototype, and `state["constructor"]` shadows its
 * constructor. On a plain object literal the blast radius is contained
 * (the write lands on the one object, not on `Object.prototype`), but
 * it becomes real prototype pollution the moment anything downstream
 * uses `in`, `hasOwnProperty`, or a recursive deep-merge on the
 * tainted object — which is exactly the kind of change that gets added
 * later without re-auditing the merge sites.
 *
 * So: one shared guard, applied at every merge boundary, dropping the
 * dangerous keys instead of assigning them. Dropping (not throwing) is
 * deliberate — these keys are never legitimate state fields, and a
 * merge boundary in the middle of a settled iteration is the wrong
 * place to fail a run. Callers get the dropped keys back so they can
 * log the anomaly.
 */

/**
 * Keys that must never be written through a dynamic-key assignment.
 * `__proto__` repoints the prototype; `constructor` / `prototype`
 * are the standard escalation path from there.
 */
export const UNSAFE_MERGE_KEYS: ReadonlyArray<string> = ["__proto__", "constructor", "prototype"];

const UNSAFE_MERGE_KEY_SET = new Set(UNSAFE_MERGE_KEYS);

/**
 * True when `key` must not be assigned onto an object built from
 * untrusted (model/tool-influenced) data.
 */
export function isUnsafeMergeKey(key: string): boolean {
  return UNSAFE_MERGE_KEY_SET.has(key);
}

/**
 * Assign one key onto `target`, skipping prototype-tampering keys.
 * Returns `true` when the value was written, `false` when the key was
 * refused.
 */
export function assignSafeKey(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): boolean {
  if (isUnsafeMergeKey(key)) {
    return false;
  }

  target[key] = value;

  return true;
}

/**
 * Shallow-merge every own enumerable key of `source` into `target`,
 * skipping prototype-tampering keys. Mutates `target` in place (call
 * sites rely on external references to the merged object staying
 * coherent) and returns the list of refused keys — empty in the
 * overwhelmingly common case, non-empty only when something upstream
 * tried to smuggle `__proto__`/`constructor`/`prototype` through.
 */
export function mergeSafely(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): string[] {
  const skipped: string[] = [];

  for (const [key, value] of Object.entries(source)) {
    if (!assignSafeKey(target, key, value)) {
      skipped.push(key);
    }
  }

  return skipped;
}
