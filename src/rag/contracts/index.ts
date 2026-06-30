/**
 * RAG contracts — the public data shapes + interface devs type their own
 * consumers against. The `rag(config)` factory that implements {@link Rag}
 * lives under `src/rag/rag.ts`; the splitters, store adapter, and rerankers
 * live in their respective sub-folders.
 */

// Documents
export type { RagDocument } from "./rag-document.type";

// Chunking
export type { Chunk, ChunkOptions, ChunkType } from "./chunk-options.type";

// Citation / retrieval shapes
export type {
  Citation,
  RetrievedChunk,
  RetrieveOptions,
  RetrieveResult,
} from "./citation.type";

// Pipeline + config
export type { Rag, RagAsToolOptions, RagConfig } from "./rag-config.type";
