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
   * Id → text/metadata. A `Map` preserves insertion order, so iteration
   * yields oldest-first; recall reverses it for most-recent-first.
   */
  private readonly entries = new Map<
    string,
    { text: string; metadata?: Record<string, unknown> }
  >();

  /**
   * Append an item to the buffer (or overwrite the entry sharing its
   * id). Re-inserting an existing id keeps its original position; delete
   * + set would move it to the end and lie about recency, so the value
   * is updated in place.
   */
  public remember(item: MemoryItem): void {
    const id = item.id ?? deriveMemoryId(item.text);

    this.entries.set(id, { text: item.text, metadata: item.metadata });
  }

  /**
   * Return up to `k` most-recently-remembered items, newest first. The
   * `score` is a linear recency proxy: the newest item scores `1`, the
   * oldest of the returned slice trends toward `0`. Working memory
   * ignores any similarity threshold — it has no vector to compare.
   */
  public recall(k: number): RecalledMemory[] {
    const ordered = [...this.entries.entries()].reverse();
    const slice = ordered.slice(0, Math.max(0, k));

    return slice.map(([id, entry], index) => ({
      id,
      text: entry.text,
      tier: "working" as const,
      score: slice.length <= 1 ? 1 : 1 - index / slice.length,
      metadata: entry.metadata,
    }));
  }

  /** Drop every working-tier entry. */
  public clear(): void {
    this.entries.clear();
  }
}
