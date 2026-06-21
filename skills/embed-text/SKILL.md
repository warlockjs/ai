---
name: embed-text
description: 'Text-to-vector via sdk.embedder({...}) — embed(string) for single, embedMany(string[]) for batch. Peer primitive on the SDK adapter, not wired into agents. Compose into RAG tools, workflow run steps, or ai.middleware.semanticCache. Triggers: `sdk.embedder`, `EmbedderContract`, `embedder.embed`, `embedder.embedMany`, `EmbeddingResult`, `EmbeddingBatchResult`, `dimensions`; ''embed text'', ''build RAG tool'', ''populate vector store'', ''embedding batch''; typical import `import { OpenAISDK } from "@warlock.js/ai-openai"`. Skip: cache similarity — `@warlock.js/cache/use-cache-similarity/SKILL.md`; pgvector queries — `@warlock.js/cascade/search-by-vector/SKILL.md`; competing libs `langchain` embeddings, raw `openai.embeddings.create`.'
---

# Embeddings — peer primitive on the SDK adapter

`EmbedderContract` is a sibling of `ModelContract` on `SDKAdapterContract`, not part of the agent loop. Text-in / vector-out. No streaming, no tools, no relationship to chat completions.

## Contract

```ts
interface EmbedderContract {
  readonly name: string;
  readonly provider: string;
  readonly dimensions: number;       // 0 until first call when no override given

  embed(input: string): Promise<EmbeddingResult>;
  embedMany(inputs: string[]): Promise<EmbeddingBatchResult>;
}
```

Single and batch are deliberately split — different cost profiles, different per-request token caps, different failure modes.

The `embedder()` method is **optional** on `SDKAdapterContract` — not every provider supports embeddings:

```ts
if (typeof sdk.embedder === "function") {
  const embedder = sdk.embedder({ name: "text-embedding-3-small" });
}
```

## OpenAI adapter — first implementation

```ts
import { OpenAISDK } from "@warlock.js/ai-openai";

const openai = new OpenAISDK({ apiKey: process.env.OPENAI_API_KEY! });
const embedder = openai.embedder({ name: "text-embedding-3-small" });

const one = await embedder.embed("Hello, world.");
// { vector: number[], dimensions: number, usage: { promptTokens, totalTokens } }

const many = await embedder.embedMany(["foo", "bar", "baz"]);
// { vectors: number[][], dimensions: number, usage: { promptTokens, totalTokens } }
```

## Not wired into the agent loop

Embeddings are deliberately not automatic. Consumers obtain an embedder from the adapter and call it directly. Composes into:

- **Retrieval tools** the agent can call (RAG pattern).
- **`run` steps** in a workflow (vector ingest, catalog item embedding).
- **Query vectors** for `ai.middleware.semanticCache` — see [`@warlock.js/ai/attach-ai-middleware/SKILL.md`](@warlock.js/ai/attach-ai-middleware/SKILL.md).
- **Cascade vector columns** for native pgvector search — see [`@warlock.js/cascade/search-by-vector/SKILL.md`](@warlock.js/cascade/search-by-vector/SKILL.md).
- **Cache similarity retrieval** via `cache.set({ vector })` + `cache.similar(...)` — see [`@warlock.js/cache/use-cache-similarity/SKILL.md`](@warlock.js/cache/use-cache-similarity/SKILL.md).

## Usage example — workflow `run` step

```ts
ai.step({
  name: "embed",
  run: async (ctx) => {
    const text = `${ctx.steps.extract.output.name} ${ctx.steps.extract.output.description}`;
    const { vector } = await embedder.embed(text);
    ctx.state.embedding = vector;
  },
  output: { extract: (ctx) => ({ dims: (ctx.state.embedding as number[]).length }) },
});
```

## Pattern — RAG tool

```ts
import { v } from "@warlock.js/seal";

const searchKb = ai.tool({
  name: "searchKb",
  description: "Search the knowledge base for relevant passages.",
  input: v.object({ query: v.string(), k: v.number().optional() }),
  execute: async ({ query, k }) => {
    const { vector } = await embedder.embed(query);
    const hits = await vectorStore.query(vector, { topK: k ?? 5 });
    return hits.map((h) => ({ text: h.text, score: h.score, source: h.source }));
  },
});

ai.agent({ model, tools: [searchKb] });
```

## Dimensions

`embedder.dimensions` is `0` on a fresh embedder when no override is given — populated from the first embed call's response. Pre-seed via the adapter's `dimensions` config option when you need the value before the first call (e.g. to size a vector column in a migration schema).

## Retrieval is app-level

No built-in vector store. Bring your own (pgvector / Qdrant / Pinecone / Chroma / cache's `similar()`) and wrap it in an `ai.tool({...})`.

## See also

- [`@warlock.js/ai/run-ai-agent/SKILL.md`](@warlock.js/ai/run-ai-agent/SKILL.md) — composing embedders into tools
- [`@warlock.js/ai/run-ai-workflow/SKILL.md`](@warlock.js/ai/run-ai-workflow/SKILL.md) — embeddings inside `run` steps
- [`@warlock.js/ai/persist-ai-data/SKILL.md`](@warlock.js/ai/persist-ai-data/SKILL.md) — performance guidance on vector storage
- [`@warlock.js/cache/use-cache-similarity/SKILL.md`](@warlock.js/cache/use-cache-similarity/SKILL.md) — cache as a vector store
- [`@warlock.js/cascade/search-by-vector/SKILL.md`](@warlock.js/cascade/search-by-vector/SKILL.md) — cascade `similarTo` query method
