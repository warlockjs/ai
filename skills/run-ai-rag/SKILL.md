---
name: run-ai-rag
description: 'Retrieval-augmented generation with ai.rag({...}) — a chunk → embed → vector-store → retrieve → rerank → cite pipeline that reuses ai.embedder + a @warlock.js/cache CacheDriver. Covers index() / retrieve() / clear() / asTool(), chunking strategies (recursive | markdown | sentence | fixed), Citation / RetrievedChunk provenance, and the opt-in rerankers ai.rag.keywordReranker / ai.rag.llmReranker. Triggers: `ai.rag`, `rag.index`, `rag.retrieve`, `rag.clear`, `rag.asTool`, `RagConfig`, `RagDocument`, `RetrieveOptions`, `RetrieveResult`, `RetrievedChunk`, `Citation`, `ChunkOptions`, `ChunkType`, `ai.rag.keywordReranker`, `ai.rag.llmReranker`, `cacheVectorStore`, `VectorStore`, `topK`, `threshold`, `candidates`; ''build a knowledge base'', ''retrieve relevant chunks for a query'', ''cite the source of an answer'', ''chunk markdown for embedding'', ''rerank retrieval results'', ''expose retrieval as a tool''; typical import `import { ai } from "@warlock.js/ai"`. Skip: raw single-string embedding — `@warlock.js/ai/embed-text/SKILL.md`; exact + vector LLM-response cache — `@warlock.js/ai/attach-ai-middleware/SKILL.md` (ai.middleware.semanticCache); tool wiring — `@warlock.js/ai/define-ai-tool/SKILL.md`; competing libs `langchain`, `llamaindex`.'
---

# `ai.rag()` — chunk → embed → retrieve → rerank → cite

A self-contained retrieval pipeline. It reuses the embedder you already have (`provider.embedder(...)`), a `@warlock.js/cache` vector-capable `CacheDriver` as the store, and the composite-as-tool engine for `asTool()`. Zero new dependencies. `ai.rag` is a native core verb — present the moment `@warlock.js/ai` is imported (no module augmentation, no side-effect import).

## Factory shape

```ts
import { ai } from "@warlock.js/ai";
import { MemoryCacheDriver } from "@warlock.js/cache";
import { OpenAISDK } from "@warlock.js/ai-openai";

const openai = new OpenAISDK({ apiKey: process.env.OPENAI_API_KEY! });

const kb = ai.rag({
  name: "docs",                                            // default "rag"
  embedder: openai.embedder({ name: "text-embedding-3-small" }), // REQUIRED
  store: new MemoryCacheDriver(),                          // or ai.config({ defaultStore })
  namespace: "ai.rag.docs",                                // default `ai.rag.<name>`
  chunk: { type: "markdown", size: 800, overlap: 120 },    // index() defaults
  reranker: ai.rag.keywordReranker(),                      // OFF by default (cosine-only)
  retrieve: { topK: 4, threshold: 0.5 },                   // default retrieval knobs
});
```

Resolution is **loud at construction** (mirrors `ai.memory`):

- `embedder` is **required** — a provider with no embedder must be caught here, not at first `index()`.
- `store` falls back to `ai.config({ defaultStore })`; if neither resolves, the factory throws.

## Surface — `Rag`

```ts
interface Rag {
  readonly name: string;
  index(docs: RagDocument[], chunk?: ChunkOptions): Promise<{ chunks: number }>;
  retrieve(query: string, options?: RetrieveOptions): Promise<RetrieveResult>;
  clear(): Promise<void>;
  asTool(options?: RagAsToolOptions): ToolContract<{ query: string }, RetrieveResult>;
}
```

## `index()` — chunk, embed (batched), store

```ts
await kb.index([
  { id: "guide", text: longMarkdown, metadata: { url: "/guide" }, tags: ["frontend"] },
  { id: "faq", text: faqText },
]);
```

A `RagDocument` is `{ id, text, metadata?, tags? }` — **you** load + parse documents to text (loaders are out of scope for v1). Each doc is split into chunks, embedded in sub-batches of 96 texts per `embedMany()` call (so one giant doc never blows the provider's per-request cap), and upserted. Returns the chunk count written. Empty / whitespace-only documents yield zero chunks — nothing is embedded. The per-call `chunk` arg overrides `config.chunk` for that index.

## Chunking — `ChunkOptions`

All sizing is in **characters** (tokenizer-free; the embedder owns token counting). `chunk(text, options)` is also exported standalone.

```ts
type ChunkType = "recursive" | "sentence" | "fixed" | "markdown";

{
  type?: ChunkType,          // default "recursive"
  size?: number,             // target chars per chunk, default 1000
  overlap?: number,          // chars carried between adjacent chunks, default 200
  separators?: string[],     // recursive only; default ["\n\n", "\n", ". ", " ", ""]
}
```

- **`recursive`** (default) — separator-aware greedy packing, largest unit first.
- **`markdown`** — heading/section-aware, then recursive within each section.
- **`sentence`** — packs whole sentences up to `size`.
- **`fixed`** — back-to-back character windows.

Every chunk records its exact `[start, end)` span in the original text, so a `Citation.span` is precise.

## `retrieve()` — embed query, fetch, rerank, slice, cite

```ts
const { query, chunks } = await kb.retrieve("how do I configure caching?", {
  topK: 4,          // returned AFTER reranking. default 5
  threshold: 0.5,   // cosine floor at the store stage. default 0.5
  candidates: 16,   // pool fetched before rerank. default topK * 4 (clamped >= topK)
  tags: ["frontend"], // restrict to chunks whose source had one of these tags
});

for (const hit of chunks) {
  console.log(hit.score, hit.text);
  console.log(hit.citation.sourceId, hit.citation.chunkIndex, hit.citation.span);
}
```

`retrieve()` is **return-only** — it never auto-injects into a prompt. The caller formats the cited chunks (or uses `asTool()` for the agent loop). A `RetrievedChunk` carries `{ text, score, citation }`; the `Citation` is `{ sourceId, chunkIndex, span, score, metadata? }`. The reranker is **OFF by default** (cosine ranking only) unless `config.reranker` is set.

## Rerankers — opt-in, on `ai.rag.*`

Both are exposed as namespaced helpers on the factory (`ai.rag.keywordReranker`, `ai.rag.llmReranker`).

```ts
// Zero-dependency lexical reranker (BM25-lite keyword overlap).
ai.rag.keywordReranker({ weight: 0.5 }); // weight in [0,1]; 1 = pure keyword, 0 = keep cosine

// Model-backed reranker — one or more model calls per retrieval.
ai.rag.llmReranker({ model: openai.model({ name: "gpt-4o-mini" }), batchSize: 10 });
```

- **`keywordReranker`** — blends lexical query-term overlap with the original cosine score by `weight`; ties keep the incoming cosine order. Costs nothing beyond string splits. Reach for it when embedding-only ranking buries a keyword-rich chunk.
- **`llmReranker`** — asks an LLM to grade each over-fetched candidate `0..1` and sorts by that. Candidates the model fails to score keep their cosine score, so a garbled reply degrades gracefully. Opt in only when precision beats latency/cost. Both implement the `RagReranker` contract, so you can write your own.

## `asTool()` — drop retrieval into an agent's `tools: []`

```ts
const agent = ai.agent({
  model: openai.model({ name: "gpt-4o" }),
  tools: [kb.asTool({ name: "search_docs", retrieve: { topK: 6 } })],
});
```

Input is `{ query: string }`; output is the `RetrieveResult`. Default tool name is `retrieve_<rag.name>`; `description` and a per-tool `retrieve` override are optional. Built via the same composite-as-tool engine every other primitive uses.

## `clear()`

```ts
await kb.clear(); // drops every entry written under this rag's namespace
```

## Advanced

- `cacheVectorStore(driver)` + the `VectorStore` contract are exported for swapping in a custom store.
- A stored chunk's namespaced key is `${namespace}.${sourceId}.${chunkIndex}`.

## See also

- [`@warlock.js/ai/embed-text/SKILL.md`](@warlock.js/ai/embed-text/SKILL.md) — the `sdk.embedder` primitive this consumes
- [`@warlock.js/ai/define-ai-tool/SKILL.md`](@warlock.js/ai/define-ai-tool/SKILL.md) — what `asTool()` produces
- [`@warlock.js/ai/run-ai-agent/SKILL.md`](@warlock.js/ai/run-ai-agent/SKILL.md) — wiring the retrieval tool into an agent
