import type { EvalCase } from "../contracts/agent/eval.type";

/**
 * A single dataset row. A superset of {@link EvalCase} — every dataset
 * entry is a valid eval case, plus optional `tags` for filtering and
 * sharding a large suite.
 */
export type DatasetEntry<TOutput = unknown> = EvalCase<TOutput> & {
  /** Optional tags for filtering / sharding a large dataset. */
  tags?: string[];
};

/**
 * An immutable, filterable, shardable collection of {@link DatasetEntry}
 * rows that feeds `agent.eval({ cases })` directly. Built via the
 * {@link dataset} factory — never `new`.
 */
export type DatasetContract<TOutput = unknown> = {
  /** Stable identifier for the dataset — surfaced for logging / artifacts. */
  readonly name: string;
  /** All entries (after any filter / shard applied at construction). */
  readonly cases: DatasetEntry<TOutput>[];
  /**
   * Narrow by an arbitrary predicate (typically a tag check) — returns a
   * new dataset sharing nothing mutable with this one.
   */
  filter(
    predicate: (entry: DatasetEntry<TOutput>) => boolean,
  ): DatasetContract<TOutput>;
  /**
   * Deterministic shard `index`-of-`total` for parallel CI jobs. Every
   * entry lands in exactly one shard (round-robin by position), so the
   * union of all `total` shards reproduces the full case list with no
   * gaps or overlaps.
   */
  shard(index: number, total: number): DatasetContract<TOutput>;
};

/**
 * Options for the {@link dataset} factory. Supply `cases` inline, or
 * `fromFile` to load a JSONL file (one JSON-encoded {@link DatasetEntry}
 * per line) synchronously at construction — mirroring
 * `SystemPrompt.fromFile`'s one-shot sync read. Both may be combined;
 * file entries are appended after inline `cases`.
 */
export type DatasetOptions<TOutput = unknown> = {
  /** Stable identifier for the dataset. */
  name: string;
  /** Inline entries. */
  cases?: DatasetEntry<TOutput>[];
  /**
   * Path to a JSONL file read once, synchronously, at construction. Each
   * non-blank line must be a JSON object matching {@link DatasetEntry}; a
   * malformed line throws an `InvalidRequestError` naming the 1-based line
   * number.
   */
  fromFile?: string;
};
