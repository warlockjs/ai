---
name: rag-loaders-and-stores
description: 'Turn any source into a RagDocument and index it in a production vector store — the document loaders ai.rag.loadText / loadHtml / loadWeb (SSRF-safe via guardedFetch) / loadPdf (lazy pdf-parse peer), plus the swappable stores ai.rag.pgVectorStore({client}) (pgvector + ensureSchema DDL + hnsw/ivfflat index) and ai.rag.cacheVectorStore(driver), both satisfying VectorStoreContract (upsert / query / removeNamespace). Loaders return the exact RagDocument[] that kb.index() consumes — no adapter. Triggers: `ai.rag.loadText`, `ai.rag.loadHtml`, `ai.rag.loadWeb`, `ai.rag.loadPdf`, `loadText`, `loadHtml`, `loadWeb`, `loadPdf`, `ai.rag.pgVectorStore`, `ai.rag.cacheVectorStore`, `pgVectorStore`, `cacheVectorStore`, `VectorStore`, `PgVectorStoreOptions`, `PgVectorStoreInstance`, `ensureSchema`, `schema()`, `RagLoaderResult`, `LoadWebOptions`, `LoadPdfOptions`, `perPage`, `OutboundPolicy`, `guardedFetch`, `hnsw`, `ivfflat`, `pgvector`, `dimensions`, `PgClientLike`, `PDF_PARSE_INSTALL_INSTRUCTIONS`; ''load a website into a knowledge base'', ''index a PDF for RAG'', ''strip HTML to text for embedding'', ''pgvector store for RAG'', ''SSRF-safe document fetch'', ''one document per PDF page'', ''swap the vector store''; typical import `import { ai } from "@warlock.js/ai"`. Skip: the chunk → embed → retrieve → rerank → cite pipeline that consumes these — `@warlock.js/ai/run-ai-rag/SKILL.md`; the raw embedder primitive — `@warlock.js/ai/embed-text/SKILL.md`; cache similarity internals — `@warlock.js/cache/use-cache-similarity/SKILL.md`; competing libs `langchain` loaders, `llamaindex` readers.'
---

# RAG loaders + vector stores — source → `RagDocument` → durable store

Two feature groups that bracket `ai.rag()`: **loaders** turn a source (string, raw HTML, a URL, or PDF bytes) into the exact `RagDocument[]` shape `kb.index()` consumes, and **stores** are the swappable backends that hold the embeddings. Both live on the `ai.rag.*` namespace — present the moment `@warlock.js/ai` is imported, no side-effect import, no module augmentation.

## Contract — what each side produces / satisfies

Every loader returns `RagLoaderResult` — a plain `RagDocument[]` — so a load feeds `index()` with no adapter and callers never branch on arity (one page ⇒ 1 doc, a per-page PDF ⇒ N docs):

```ts
type RagLoaderResult = RagDocument[];
type RagDocument = { id: string; text: string; metadata?: Record<string, unknown>; tags?: string[] };
```

Every store satisfies the three-method `VectorStore` contract (a thin narrowing of the cache `similar()` surface — NOT a new engine):

```ts
interface VectorStore {
  upsert(key: string, value: unknown, vector: number[], tags?: string[]): Promise<void>;
  query<T>(vector: number[], options: { topK: number; threshold?: number; tags?: string[] }): Promise<{ key: string; value: T; score: number }[]>;
  removeNamespace(namespace: string): Promise<void>;
}
```

## Loaders

| Loader | Input | Deps | Emits |
|---|---|---|---|
| `ai.rag.loadText(input, opts?)` | `string` \| `{ id, text }` \| array of either | none | one doc per non-empty item |
| `ai.rag.loadHtml(html, opts?)` | raw HTML string | none (regex strip) | one doc, `metadata.title` from `<title>` |
| `ai.rag.loadWeb(url, opts?)` | absolute URL | none (uses core `guardedFetch`) | one doc, SSRF-safe fetch |
| `ai.rag.loadPdf(bytes, opts?)` | `Buffer` \| `ArrayBuffer` \| `Uint8Array` | lazy `pdf-parse` peer | one doc, or one per page with `perPage: true` |

Shared options (`RagLoaderOptions`): `id` (source id — falls back to the URL for web, `"document"` otherwise), `metadata` (merged **over** the loader-derived keys, so an explicit `metadata.title` always wins), and `tags` (applied to every chunk for `retrieve({ tags })` filtering). Loader-derived keys: `source`, `loader` (`"text" | "html" | "web" | "pdf"`), plus `title` / `page` / `pageCount` / `contentType` where determinable. Empty / whitespace-only / all-markup inputs emit **no** document — never a no-op record for `index()` to skip.

```ts
import { ai } from "@warlock.js/ai";

// Bare string, or many records → many distinctly-identified docs:
await kb.index(ai.rag.loadText([
  { id: "faq-billing", text: "…", metadata: { section: "billing" } },
  { id: "faq-shipping", text: "…" },
]));

// Raw HTML → readable text (scripts/styles dropped, entities decoded):
await kb.index(ai.rag.loadHtml(rawHtml, { id: "landing", tags: ["marketing"] }));
```

### `loadWeb` is SSRF-safe — never a raw `fetch`

Every request goes through core's `guardedFetch` under an `OutboundPolicy`. The strict defaults (https-only, private-IP-deny on, 10s timeout, 5 MiB cap) apply even when you pass no `policy`, so an untuned call is already hardened. Tighten it per call:

```ts
await kb.index(await ai.rag.loadWeb("https://docs.example.com/guide", {
  policy: { hostAllowlist: ["docs.example.com"], maxBytes: 2_000_000, timeoutMs: 5_000 },
  tags: ["docs"],
}));
```

HTML responses run through the same tag-strip pass as `loadHtml`; non-HTML text (`text/plain`, markdown) is used verbatim. `metadata.source` is the resolved URL, `metadata.contentType` the server-reported type. A non-OK response, a policy block, a timeout, or an over-cap body throws `OutboundPolicyError`.

### `loadPdf` — lazy optional peer, page-precise citations

`pdf-parse` is an **optional** peer, dynamic-imported on the FIRST `loadPdf` call — importing `@warlock.js/ai` never forces it. When it is absent, the curated `PDF_PARSE_INSTALL_INSTRUCTIONS` string is thrown as a plain `Error` (a missing infra peer, not a content problem), never a raw module-resolution stack trace.

```ts
import { readFile } from "node:fs/promises";

// Whole PDF → one doc carrying metadata.pageCount:
await kb.index(await ai.rag.loadPdf(await readFile("manual.pdf"), { id: "manual" }));

// One doc per page → citations stay page-precise (id suffixed `#p<n>`, metadata.page set):
await kb.index(await ai.rag.loadPdf(bytes, { id: "manual", perPage: true }));
```

An image-only / scanned page has no text layer and is dropped, so a fully-scanned PDF yields zero docs (nothing to embed).

## Stores

### `ai.rag.cacheVectorStore(driver)` — adapt any `@warlock.js/cache` driver

The cache driver **is** the vector store — `upsert → set({ vector, tags })`, `query → similar()`, `removeNamespace → removeNamespace()`. A driver without similarity support throws `CacheUnsupportedError` unchanged (pointing you at the `pg` / `redis` cache drivers).

```ts
import { MemoryCacheDriver } from "@warlock.js/cache";

const store = ai.rag.cacheVectorStore(new MemoryCacheDriver()); // dev / tests
```

### `ai.rag.pgVectorStore(options)` — production pgvector

One durable row per chunk keyed by the pipeline's dotted key, the chunk payload in a `JSONB` `value` column, the embedding in a pgvector `vector` column. Pass a live pool (`{ client }` — `@warlock.js/ai` imports **nothing**) or a `{ connectionString }` and let the store lazily `import("pg")` (the optional peer; curated install string on first use if absent). Exactly one of the two is required.

```ts
type PgVectorStoreOptions = {
  client?: PgClientLike;               // a pg.Pool / pg.Client — only `query` is ever called
  connectionString?: string;           // else the store builds its own Pool lazily
  table?: string;                      // default "warlock_ai_rag_vectors"; must be a safe identifier
  dimensions?: number;                 // vector(N) width in the DDL, default 1536
  index?: "hnsw" | "ivfflat" | "none"; // ANN strategy, default "hnsw"
  ivfflatLists?: number;               // ivfflat only, default 100
};
```

`schema()` (alias `ensureSchema()`) returns the reference migration DDL — `CREATE EXTENSION vector`, the table, a GIN index on `tags`, and the chosen ANN index (`USING hnsw (embedding vector_cosine_ops)`). It **only returns the string**; the framework never auto-migrates — you run it once through your own tool. Index and query MUST use the same embedding model: the `vector(N)` width is fixed at table-creation time from `dimensions`.

```ts
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = ai.rag.pgVectorStore({ client: pool, dimensions: 1536, index: "hnsw" });

// Once, via your migration tooling — never auto-run:
await pool.query(store.ensureSchema());
```

`query()` runs the cosine floor (`threshold`) and `tags` overlap filter **in SQL** (a below-floor row never crosses the wire), orders by `embedding <=> $vec`, caps at `topK`, and maps the pgvector distance back to a `[0,1]` cosine-similarity `score` — the same scale the cache store emits. `removeNamespace()` is a prefix DELETE that escapes `_` / `%` so dropping `ai.rag.docs` never also catches `ai.rag.docs2`.

## Pattern — a knowledge base from a website, backed by pgvector

```ts
import { Pool } from "pg";
import { ai } from "@warlock.js/ai";
import { OpenAISDK } from "@warlock.js/ai-openai";

const openai = new OpenAISDK({ apiKey: process.env.OPENAI_API_KEY! });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const store = ai.rag.pgVectorStore({ client: pool, dimensions: 1536 });
await pool.query(store.ensureSchema()); // once at boot / migration

const kb = ai.rag({
  name: "docs",
  embedder: openai.embedder({ name: "text-embedding-3-small" }), // 1536 dims — matches the DDL
  store,
});

// Crawl a few pages (SSRF-safe) + a spec PDF into the same namespace:
for (const url of ["https://docs.example.com/intro", "https://docs.example.com/config"]) {
  await kb.index(await ai.rag.loadWeb(url, { policy: { hostAllowlist: ["docs.example.com"] }, tags: ["docs"] }));
}
await kb.index(await ai.rag.loadPdf(await readFile("spec.pdf"), { id: "spec", perPage: true, tags: ["spec"] }));

// Now retrieve — every hit's citation traces back to its source URL / page:
const { chunks } = await kb.retrieve("how do I configure caching?", { topK: 4, tags: ["docs"] });
```

The `embedder`'s `dimensions` MUST equal the store's `dimensions` — a mismatch is a runtime insert failure at the pgvector column, not a type error.

## Cost + testing

- **Loaders are cheap.** `loadText` / `loadHtml` are zero-dependency string passes; `loadWeb` costs one guarded HTTP round-trip; `loadPdf` costs the `pdf-parse` parse. **None embed** — embedding cost lands entirely in `kb.index()` (batched, 96 texts per `embedMany` call). The token spend is per chunk, so `perPage` PDFs and finer chunking mean more, smaller vectors.
- **`pgVectorStore` construction is synchronous and does no I/O** — the `pg` import + pool build are deferred to first `query`/`upsert`. Table-name validation (`/^[A-Za-z_][A-Za-z0-9_]*$/`) throws at construction, so a `table: "bad; DROP TABLE x"` fails fast.
- **Unit-test loaders with fixtures** (a stubbed `policy.fetch` for `loadWeb`, `vi.mock("pdf-parse")` for `loadPdf` — the literal specifier is mockable). Test stores against a `FakePgClient` implementing `{ query }`, or `cacheVectorStore(new MemoryCacheDriver())` for a real end-to-end index/retrieve with no external service.

## See also

- [[run-ai-rag]] — the chunk → embed → retrieve → rerank → cite pipeline that **consumes** these loaders and stores (`ai.rag({ embedder, store })`, `index()` / `retrieve()`).
- [[embed-text]] — the `sdk.embedder` primitive whose `dimensions` must match the store's `vector(N)` width.
- [`@warlock.js/cache/use-cache-similarity/SKILL.md`](@warlock.js/cache/use-cache-similarity/SKILL.md) — the cache driver `cacheVectorStore` adapts.
