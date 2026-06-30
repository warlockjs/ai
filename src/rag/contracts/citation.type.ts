/** Where a retrieved chunk came from — the unit an answer cites. */
export type Citation = {
  /** `id` of the source `RagDocument` this chunk was split from. */
  sourceId: string;
  /** 0-based index of the chunk within its source document. */
  chunkIndex: number;
  /** Character span `[start, end)` of the chunk inside the original source text. */
  span: [start: number, end: number];
  /** Relevance score the retrieval assigned, in `[0, 1]`. */
  score: number;
  /** Metadata copied verbatim from the source document. */
  metadata?: Record<string, unknown>;
};

/** A single retrieval hit, carrying its citation. */
export type RetrievedChunk = {
  /** Chunk text injected into the model prompt. */
  text: string;
  /** Relevance in `[0, 1]` — cosine similarity, or the reranker's score when one ran. */
  score: number;
  /** Provenance for grounding the answer. */
  citation: Citation;
};

/** Knobs controlling a single `retrieve()` call. */
export type RetrieveOptions = {
  /** Number of chunks to return AFTER reranking. Default 5. */
  topK?: number;
  /** Cosine floor `[0, 1]` applied at the vector-store stage. Default 0.5. */
  threshold?: number;
  /**
   * Candidate pool size fetched from the store before reranking. Defaults
   * to `topK * 4` (clamped to >= topK) — an overscan that mirrors the
   * episodic/procedural memory tiers' `k * 5` pattern.
   */
  candidates?: number;
  /** Restrict retrieval to chunks whose source had one of these tags. */
  tags?: string[];
};

/** Result of a single retrieval. */
export type RetrieveResult = {
  /** The query that was embedded. */
  query: string;
  /** Ranked, cited chunks. */
  chunks: RetrievedChunk[];
};
