/**
 * Derive a stable memory id from its text when the caller didn't supply
 * one. Re-remembering identical text therefore lands on the same id and
 * overwrites in place rather than duplicating.
 *
 * FNV-1a variant — cheap, dependency-free, collision-resistant enough
 * for de-duplicating memory entries. NOT cryptographic: a collision
 * would merge two distinct memories, not breach security in the current
 * trust model. Mirrors the prompt hash in
 * `middleware/builtins/semantic-cache.ts`.
 */
export function deriveMemoryId(text: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16);
}
