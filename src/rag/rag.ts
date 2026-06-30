import { resolveDefaultStore } from "../config";
import { chunk as chunkText } from "./chunk/chunk";
import type { ChunkOptions } from "./contracts/chunk-options.type";
import type { RetrieveOptions, RetrieveResult } from "./contracts/citation.type";
import type {
  Rag,
  RagAsToolOptions,
  RagConfig,
} from "./contracts/rag-config.type";
import type { RagDocument } from "./contracts/rag-document.type";
import { ragAsTool } from "./as-tool";
import { retrieve as runRetrieve, type StoredChunk } from "./retrieve";
import { cacheVectorStore } from "./store/cache-vector-store";
import type { VectorStore } from "./store/vector-store.contract";

const DEFAULT_NAME = "rag";
const DEFAULT_NAMESPACE_PREFIX = "ai.rag";

/**
 * Max chunk texts embedded per `embedder.embedMany()` call. One call is
 * one provider request, so a giant document is sub-batched to stay under
 * the provider's per-request token cap (the design's "chunk larger than
 * provider per-request cap" guard).
 */
const DEFAULT_MAX_BATCH = 96;

/**
 * Create a RAG pipeline: **chunk → embed → vector store → retrieve →
 * rerank → cite**, reusing the app's `ai.embedder` for embedding, a
 * `@warlock.js/cache` `CacheDriver` as the vector store, and the
 * composite-as-tool engine to expose retrieval as a tool.
 *
 * Resolution is loud at construction (mirroring `memory()`):
 * - `embedder` is required — a provider with no embedder must be caught
 *   here, not at first index.
 * - `store` falls back to `ai.config({ defaultStore })`; if neither
 *   resolves, construction throws.
 *
 * `retrieve()` is return-only — it never auto-injects into a prompt; the
 * caller formats the cited chunks (or uses `asTool()` for the agent loop).
 * The reranker is OFF by default (cosine-only) unless `config.reranker`
 * is set.
 *
 * @example
 * import { ai } from "@warlock.js/ai";
 * import { MemoryCacheDriver } from "@warlock.js/cache";
 *
 * const kb = ai.rag({
 *   name: "docs",
 *   embedder: openai.embedder({ name: "text-embedding-3-small" }),
 *   store: new MemoryCacheDriver(),
 *   chunk: { type: "markdown", size: 800, overlap: 120 },
 * });
 *
 * await kb.index([{ id: "guide", text: longMarkdown, metadata: { url: "/guide" } }]);
 * const { chunks } = await kb.retrieve("how do I configure caching?", { topK: 4 });
 */
export function rag(config: RagConfig): Rag {
  const name = config.name ?? DEFAULT_NAME;

  if (!config.embedder) {
    throw new Error(
      `rag("${name}"): an \`embedder\` is required — pass one from a provider that supports embeddings (e.g. openai.embedder({ name: "text-embedding-3-small" }))`,
    );
  }

  const driver = config.store ?? resolveDefaultStore();

  if (!driver) {
    throw new Error(
      `rag("${name}"): no store — pass \`store\` (a vector-capable @warlock.js/cache CacheDriver) or call \`ai.config({ defaultStore })\` at app boot before constructing the rag`,
    );
  }

  const store: VectorStore = cacheVectorStore(driver);
  const namespace = config.namespace ?? `${DEFAULT_NAMESPACE_PREFIX}.${name}`;
  const embedder = config.embedder;

  // Captured at first index for the dimension-mismatch guard in retrieve().
  let indexedDimensions: number | undefined;

  const instance: Rag = {
    name,

    async index(
      docs: RagDocument[],
      chunkOverride?: ChunkOptions,
    ): Promise<{ chunks: number }> {
      const chunkOptions = chunkOverride ?? config.chunk;

      // Ingestion guardrails (D5) — fail BEFORE any embedding spend.
      const limits = config.limits;
      if (limits?.maxDocuments !== undefined && docs.length > limits.maxDocuments) {
        throw new Error(
          `rag("${name}"): index() received ${docs.length} documents, exceeding the configured maxDocuments of ${limits.maxDocuments}`,
        );
      }
      if (limits?.maxBytes !== undefined) {
        const totalBytes = docs.reduce(
          (sum, doc) => sum + Buffer.byteLength(doc.text ?? ""),
          0,
        );
        if (totalBytes > limits.maxBytes) {
          throw new Error(
            `rag("${name}"): index() received ${totalBytes} bytes of document text, exceeding the configured maxBytes of ${limits.maxBytes}`,
          );
        }
      }

      // Flatten every document into stored-chunk records + their texts,
      // preserving document order so a single batched embed maps back 1:1.
      const records: { key: string; value: StoredChunk; text: string; tags?: string[] }[] = [];

      for (const doc of docs) {
        const pieces = chunkText(doc.text, chunkOptions);

        for (const piece of pieces) {
          const value: StoredChunk = {
            sourceId: doc.id,
            chunkIndex: piece.index,
            span: piece.span,
            text: piece.text,
            metadata: doc.metadata,
          };

          records.push({
            key: keyFor(namespace, doc.id, piece.index),
            value,
            text: piece.text,
            tags: doc.tags,
          });
        }
      }

      // Empty / whitespace-only documents yield zero chunks — write
      // nothing and never embed an empty batch.
      if (records.length === 0) {
        return { chunks: 0 };
      }

      // Chunk cap (D5) — checked after chunking, still before embedding.
      if (limits?.maxChunks !== undefined && records.length > limits.maxChunks) {
        throw new Error(
          `rag("${name}"): index() produced ${records.length} chunks, exceeding the configured maxChunks of ${limits.maxChunks}`,
        );
      }

      // Sub-batch the embed calls so one giant document does not blow the
      // provider's per-request token cap.
      for (let offset = 0; offset < records.length; offset += DEFAULT_MAX_BATCH) {
        const batch = records.slice(offset, offset + DEFAULT_MAX_BATCH);
        const { vectors, dimensions } = await embedder.embedMany(
          batch.map((record) => record.text),
        );

        if (indexedDimensions === undefined && dimensions !== 0) {
          indexedDimensions = dimensions;
        }

        await Promise.all(
          batch.map((record, position) =>
            store.upsert(record.key, record.value, vectors[position], record.tags),
          ),
        );
      }

      return { chunks: records.length };
    },

    async retrieve(query: string, options?: RetrieveOptions): Promise<RetrieveResult> {
      return runRetrieve(
        query,
        {
          embedder,
          store,
          namespace,
          reranker: config.reranker,
          defaults: config.retrieve,
          indexedDimensions,
        },
        options,
      );
    },

    async clear(): Promise<void> {
      await store.removeNamespace(namespace);
    },

    asTool(options?: RagAsToolOptions) {
      return ragAsTool(name, (query, retrieveOptions) => instance.retrieve(query, retrieveOptions), options);
    },
  };

  return instance;
}

/**
 * Namespaced key for a stored chunk. Uses the `.` separator (matching
 * `SemanticMemory.keyFor`) so namespace-prefix filtering on the returned
 * `hit.key` stays aligned with the cache's `parseKey` normalization.
 */
function keyFor(namespace: string, sourceId: string, chunkIndex: number): string {
  return `${namespace}.${sourceId}.${chunkIndex}`;
}
