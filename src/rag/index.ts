/**
 * RAG pipeline (theme C). The canonical access point is `ai.rag(config)`;
 * this barrel exports the factory plus its chunker, vector-store adapter,
 * rerankers, and the public data shapes so devs can type their own
 * consumers and swap in their own splitter / store / reranker.
 *
 * `ai.rag` is a native core verb — present the moment `@warlock.js/ai` is
 * imported (no module augmentation, no side-effect import). It reuses the
 * existing `ai.embedder` for embedding, a `@warlock.js/cache` `CacheDriver`
 * as the vector store, and the composite-as-tool engine for `asTool()` —
 * zero new dependencies.
 */

// RAG
export { rag } from "./rag";
export type { Rag, RagConfig, RagAsToolOptions } from "./contracts";

// Chunking
export { chunk } from "./chunk/chunk";
export type { Chunk, ChunkOptions, ChunkType } from "./contracts";

// Vector store
export { cacheVectorStore } from "./store/cache-vector-store";
export type { VectorStore } from "./store/vector-store.contract";

// Rerank
export { keywordReranker } from "./rerank/keyword-reranker";
export type { KeywordRerankerOptions } from "./rerank/keyword-reranker";
export { llmReranker } from "./rerank/llm-reranker";
export type { LlmRerankerOptions } from "./rerank/llm-reranker";
export type { RagReranker } from "./rerank/reranker.contract";

// Citation / retrieval shapes
export type {
  Citation,
  RetrievedChunk,
  RetrieveResult,
  RetrieveOptions,
  RagDocument,
} from "./contracts";

// Hybrid retrieval (A4) — dense + BM25 lexical fusion + query transforms.
export { reciprocalRankFusion, type RankedItem } from "./hybrid/rrf";
export { bm25Rank, type LexicalDoc } from "./hybrid/bm25";
export { hybridRank } from "./hybrid/hybrid-rank";
export { multiQuery, type MultiQueryOptions } from "./transforms/multi-query";
