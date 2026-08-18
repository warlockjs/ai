import type {
  MemoryItem,
  RecalledMemory,
} from "../contracts/memory/memory-item.type";
import { deriveMemoryId } from "./derive-id";

/**
 * In-run working memory — the volatile scratch tier (memory core M1).
 *
 * Owns: an insertion-ordered buffer of remembered items keyed by id,
 * with overwrite-in-place on a repeated id. Does NOT own: durability,
 * cross-process sharing, embeddings, or similarity — working memory is
 * a plain in-process buffer the orchestrator threads across the turns of
 * a single run.
 *
 * Recall here is not semantic: with no vector index, "relevant" reduces
 * to "recent." `recall()` returns the most-recently-remembered items
 * first, each scored on a `[0, 1]` recency proxy so a caller can merge
 * working hits with semantic hits and sort on one `score` field.
 *
 * Internal to the `memory()` factory — never exported on the package
 * surface.
 */
export class WorkingMemory {
  /**
   * Scoped key → entry. A `Map` preserves insertion order, so iteration
   * yields oldest-first; recall reverses it for most-recent-first.
   *
   * The map key folds in the item's `scope` so two scopes remembering
   * identical text (same derived id) stay two independent entries
   * instead of clobbering one another; the entry keeps its logical `id`
   * and its `scope` so recall can filter and still report the id the
   * caller knows.
   */
  private readonly entries = new Map<
    string,
    {
      id: string;
      text: string;
      scope?: string;
      metadata?: Record<string, unknown>;
    }
  >();

  /**
   * Append an item to the buffer (or overwrite the entry sharing its
   * id *within the same scope*). Re-inserting an existing key keeps its
   * original position; delete + set would move it to the end and lie
   * about recency, so the value is updated in place.
   */
  public remember(item: MemoryItem): void {
    const id = item.id ?? deriveMemoryId(item.text);

    this.entries.set(scopedKey(item.scope, id), {
      id,
      text: item.text,
      scope: item.scope,
      metadata: item.metadata,
    });
  }

  /**
   * Return up to `k` most-recently-remembered items *within `scope`*,
   * newest first. The scope match is exact equality (an unscoped recall
   * sees only unscoped entries) and is applied BEFORE the slice, so a
   * foreign scope's entries can never consume a slot or leak out.
   *
   * The `score` is a linear recency proxy: the newest item scores `1`,
   * the oldest of the returned slice trends toward `0`. Working memory
   * ignores any similarity threshold — it has no vector to compare.
   */
  public recall(k: number, scope?: string): RecalledMemory[] {
    const ordered = [...this.entries.values()]
      .reverse()
      .filter((entry) => entry.scope === scope);

    const slice = ordered.slice(0, Math.max(0, k));

    return slice.map((entry, index) => ({
      id: entry.id,
      text: entry.text,
      tier: "working" as const,
      score: slice.length <= 1 ? 1 : 1 - index / slice.length,
      metadata: entry.metadata,
    }));
  }

  /** Drop every working-tier entry, across every scope. */
  public clear(): void {
    this.entries.clear();
  }
}

/**
 * Map key for a buffer entry: the isolation `scope` (empty for the
 * unscoped pool) length-prefixed and joined to the logical id. The
 * length prefix makes the encoding injective — no crafted scope/id pair
 * can collide with a different scope's entry the way a plain `:` join
 * would allow.
 */
function scopedKey(scope: string | undefined, id: string): string {
  return `${scope?.length ?? 0}:${scope ?? ""}:${id}`;
}
