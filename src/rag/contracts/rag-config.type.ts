import type { CacheDriver } from "@warlock.js/cache";
import type { EmbedderContract } from "../../contracts/embedder.contract";
import type { ToolContract } from "../../tool/tool";
import type { RagReranker } from "../rerank/reranker.contract";
import type { ChunkOptions } from "./chunk-options.type";
import type { RetrieveOptions, RetrieveResult } from "./citation.type";
import type { RagDocument } from "./rag-document.type";

/** Options for `rag.asTool()` — how retrieval is exposed to an agent. */
export type RagAsToolOptions = {
  /** LLM tool name. Default `"retrieve_<rag.name>"`. */
  name?: string;
  /** Tool description the model reads. Sensible default derived from the rag name. */
  description?: string;
  /** Override `topK` / `threshold` / `tags` for the tool path. */
  retrieve?: RetrieveOptions;
};

/** Configuration for the `rag()` factory. */
export type RagConfig = {
  /** Stable name — used in tool names, cache namespace, logs. Default `"rag"`. */
  name?: string;
  /** Embedder for both indexing and query embedding. Required. */
  embedder: EmbedderContract;
  /**
   * Vector-capable cache driver = the vector store. Falls back to
   * `ai.config({ defaultStore })` when omitted; throws at construction if
   * neither resolves (same rule as `SemanticMemoryConfig.store`).
   */
  store?: CacheDriver<any, any>;
  /** Namespace prefix for every key written. Default `"ai.rag." + name`. */
  namespace?: string;
  /** Chunking defaults for `index()`. Overridable per `index()` call. */
  chunk?: ChunkOptions;
  /** Optional reranker run between the store fetch and the topK slice. */
  reranker?: RagReranker;
  /** Default retrieval knobs. */
  retrieve?: RetrieveOptions;
  /**
   * Ingestion guardrails for `index()` (D5). Each is a hard cap that
   * throws before any embedding spend when exceeded — unbounded ingestion
   * is a real cost / memory / quota foot-gun. All optional; omit for no
   * limit (the prior behavior).
   */
  limits?: {
    /** Max documents accepted in a single `index()` call. */
    maxDocuments?: number;
    /** Max chunks produced across the call (after chunking). */
    maxChunks?: number;
    /** Max total bytes of document text accepted in a single call. */
    maxBytes?: number;
  };
};

/**
 * A configured RAG pipeline: chunk → embed → vector store → retrieve →
 * rerank → cite. Built by the `rag()` factory.
 */
export interface Rag {
  /** Stable name used in tool names, namespace, and logs. */
  readonly name: string;
  /** Chunk → embed (batched) → store. Returns the chunk count written. */
  index(docs: RagDocument[], chunk?: ChunkOptions): Promise<{ chunks: number }>;
  /** Embed the query, fetch candidates, rerank, slice topK, attach citations. */
  retrieve(query: string, options?: RetrieveOptions): Promise<RetrieveResult>;
  /** Drop every entry written under this rag's namespace. */
  clear(): Promise<void>;
  /**
   * Expose `retrieve()` as a tool for an agent's `tools: []` loop. Input is
   * `{ query: string }`; output is `RetrieveResult`. Built via the same
   * composite-as-tool engine the other primitives use.
   */
  asTool(options?: RagAsToolOptions): ToolContract<{ query: string }, RetrieveResult>;
}
