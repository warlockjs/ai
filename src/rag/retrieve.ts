import type { EmbedderContract } from "../contracts/embedder.contract";
import type {
  Citation,
  RetrievedChunk,
  RetrieveOptions,
  RetrieveResult,
} from "./contracts/citation.type";
import type { RagReranker } from "./rerank/reranker.contract";
import type { VectorStore } from "./store/vector-store.contract";

/** Default number of chunks returned after reranking. */
export const DEFAULT_TOP_K = 5;

/** Default cosine floor applied at the vector-store stage. */
export const DEFAULT_THRESHOLD = 0.5;

/**
 * Shape persisted per chunk in the vector store. The vector itself is held
 * by the driver's own index (passed via `set({ vector })`), so it is not
 * duplicated here.
 */
export type StoredChunk = {
  sourceId: string;
  chunkIndex: number;
  span: [start: number, end: number];
  text: string;
  metadata?: Record<string, unknown>;
};

/** Dependencies the retrieve pipeline needs, resolved once by `rag()`. */
export type RetrieveDeps = {
  embedder: EmbedderContract;
  store: VectorStore;
  /** Namespace prefix every stored key carries (e.g. `"ai.rag.docs"`). */
  namespace: string;
  /** Optional reranker; when absent the cosine order is kept. */
  reranker?: RagReranker;
  /** Pipeline-level retrieval defaults. */
  defaults?: RetrieveOptions;
  /**
   * Dimension count captured at first index for the mismatch guard. When
   * set, the query embedder's `dimensions` must equal it.
   */
  indexedDimensions?: number;
};

/**
 * The cite pipeline: embed the query → over-fetch candidates from the
 * store → filter to this rag's namespace → map to {@link RetrievedChunk}s
 * with a {@link Citation} → optionally rerank → slice `topK`.
 *
 * Behavior matches the design's failure modes:
 * - No hits clearing the threshold → `{ query, chunks: [] }`, never throws.
 * - Namespace-prefix filtering keeps two rags sharing one driver isolated.
 * - A reranker that throws is caught; the raw cosine order is used instead.
 * - A dimension mismatch (indexed with model A, queried with model B)
 *   throws a clear error rather than returning garbage hits.
 */
export async function retrieve(
  query: string,
  deps: RetrieveDeps,
  options: RetrieveOptions = {},
): Promise<RetrieveResult> {
  const topK = options.topK ?? deps.defaults?.topK ?? DEFAULT_TOP_K;
  const threshold = options.threshold ?? deps.defaults?.threshold ?? DEFAULT_THRESHOLD;
  const tags = options.tags ?? deps.defaults?.tags;
  const candidates = options.candidates ?? deps.defaults?.candidates ?? Math.max(topK * 4, topK);

  const { vector, dimensions } = await deps.embedder.embed(query);

  if (
    deps.indexedDimensions !== undefined &&
    dimensions !== 0 &&
    deps.indexedDimensions !== 0 &&
    dimensions !== deps.indexedDimensions
  ) {
    throw new Error(
      `rag.retrieve(): query embedder dimensions (${dimensions}) do not match the dimensions captured at index time (${deps.indexedDimensions}); index and query must use the same embedding model`,
    );
  }

  const hits = await deps.store.query<StoredChunk>(vector, {
    topK: candidates,
    threshold,
    tags,
  });

  const prefix = `${deps.namespace}.`;

  let retrieved: RetrievedChunk[] = hits
    .filter((hit) => hit.key.startsWith(prefix))
    .map((hit) => toRetrievedChunk(hit.value, hit.score));

  retrieved = await applyReranker(query, retrieved, deps.reranker);

  return { query, chunks: retrieved.slice(0, topK) };
}

/** Build a cited {@link RetrievedChunk} from a stored chunk + its cosine score. */
function toRetrievedChunk(stored: StoredChunk, score: number): RetrievedChunk {
  const citation: Citation = {
    sourceId: stored.sourceId,
    chunkIndex: stored.chunkIndex,
    span: stored.span,
    score,
    metadata: stored.metadata,
  };

  return { text: stored.text, score, citation };
}

/**
 * Run the optional reranker, degrading to the raw cosine order if it
 * throws — a flaky optional reranker must never fail the whole retrieval.
 */
async function applyReranker(
  query: string,
  candidates: RetrievedChunk[],
  reranker: RagReranker | undefined,
): Promise<RetrievedChunk[]> {
  if (!reranker) {
    return candidates;
  }

  try {
    return await reranker.rerank(query, candidates);
  } catch {
    // Logged at the call site in a richer build; here we degrade silently
    // to vector-only ranking rather than aborting the retrieval.
    return candidates;
  }
}
