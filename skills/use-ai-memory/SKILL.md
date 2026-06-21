---
name: use-ai-memory
description: 'Agent memory with ai.memory({...}) — a provider-neutral store with FOUR tiers: WORKING (in-run scratch, recalled by recency), SEMANTIC (durable facts by cosine similarity over a @warlock.js/cache vector driver via .similar()), EPISODIC (durable events, similarity blended with recency), and PROCEDURAL (durable how-tos, similarity blended with reinforcement). remember() / recall() / clear(); wire it into ai.orchestrator({ memory }). Triggers: `ai.memory`, `memory.remember`, `memory.recall`, `memory.clear`, `MemoryContract`, `MemoryConfig`, `MemoryItem`, `RecalledMemory`, `MemoryTier`, `SemanticMemoryConfig`, `EpisodicMemoryConfig`, `ProceduralMemoryConfig`, `working`, `semantic`, `episodic`, `procedural`, `defaultTier`, `threshold`, `recencyWeight`, `halfLifeMs`, `reinforcementWeight`, `injectKey`; ''give the agent memory'', ''remember user preferences'', ''semantic recall'', ''per-session working memory'', ''episodic / event memory'', ''procedural / how-to memory'', ''recency-weighted recall'', ''reinforce a procedure''; typical import `import { ai } from "@warlock.js/ai"`. Skip: orchestrator wiring of the memory — `@warlock.js/ai/run-orchestrator/SKILL.md`; the vector cache driver itself — `@warlock.js/cache/cache-basics/SKILL.md`; embeddings primitive — `@warlock.js/ai/embed-text/SKILL.md`; competing libs `mem0`, `langchain` memory.'
---

# `ai.memory()` — agent memory store

A single provider-neutral store that holds and retrieves what an agent / orchestrator should remember across turns. Four tiers ship in 4.3.0:

- **working** — in-run scratch threaded across turns of one session. Volatile, unscored, recalled in insertion order (recency). On by default.
- **semantic** — durable *facts* stored as embeddings in a `@warlock.js/cache` driver, retrieved by cosine similarity via the driver's native `.similar()` — the same delegation the `semanticCache` middleware uses. Activates only when you pass `semantic` config.
- **episodic** — durable *events*: a timestamped log retrieved by similarity **blended with recency** (recent episodes rank higher). Embedder-backed like semantic; tune with `recencyWeight` + `halfLifeMs`.
- **procedural** — durable *how-tos*: learned procedures retrieved by similarity **blended with reinforcement** — re-remembering a procedure increments its use count so well-worn procedures rank higher. Tune with `reinforcementWeight`.

> **Still deferred** — decay / forgetting (TTL falloff, eviction). The four tiers above are the full 4.3.0 surface; the `MemoryTier` union widened from `"working" | "semantic"` to add `"episodic" | "procedural"` (a non-breaking change).

## Shape

```ts
import { ai } from "@warlock.js/ai";
import { MemoryCacheDriver } from "@warlock.js/cache";
import { OpenAISDK } from "@warlock.js/ai-openai";

const openai = new OpenAISDK({ apiKey: process.env.OPENAI_API_KEY! });

const store = new MemoryCacheDriver();
store.setOptions({});

const mem = ai.memory({
  semantic: {
    embedder: openai.embedder({ name: "text-embedding-3-small" }),
    store,                                  // vector-capable CacheDriver
    namespace: "ai.memory",                 // key prefix; default "ai.memory"
  },
  defaultTier: "semantic",                  // tier a remember() item lands in without its own `tier`
  k: 5,                                     // default recall count
  threshold: 0.7,                           // default semantic similarity floor [0,1]
});

await mem.remember({ text: "User prefers concise answers." });
const hits = await mem.recall("how should I respond?", { k: 3 });
```

## Configuration rules (loud at construction)

- **At least one tier must be enabled** — `working` defaults to `true`; `semantic` / `episodic` / `procedural` each activate only when you pass their config. Enabling neither throws (`a memory with no tiers can't store or recall`).
- **A vector tier with no store throws now** — pass the tier's `store`, or set `ai.config({ defaultStore })` at boot. Applies to `semantic`, `episodic`, and `procedural`. Resolution happens once at construction, not silently on first use (the same loud-now contract `semanticCache` follows).
- **`defaultTier` must reference an enabled tier** — defaults to `"working"`.
- Set `working: false` for a durable-only memory (then set `defaultTier` to an enabled vector tier).

## Episodic & procedural tiers

Both are durable, embedder-backed tiers wired like `semantic` (`{ embedder, store? }`), but they re-rank by *time* and *use*:

```ts
const mem = ai.memory({
  episodic:   { embedder, store, recencyWeight: 0.3, halfLifeMs: 7 * 24 * 60 * 60 * 1000 },
  procedural: { embedder, store, reinforcementWeight: 0.3 },
  defaultTier: "episodic",
});

await mem.remember({ text: "Refunded order 5821 after a cracked-item complaint.", tier: "episodic" });
await mem.remember({ id: "esc", text: "Escalate refunds over $500 to a human.", tier: "procedural" });
await mem.remember({ id: "esc", text: "Escalate refunds over $500 to a human.", tier: "procedural" }); // reinforce → uses 1→2
```

- **episodic** — stamps each entry with the remember time and decays its recency on an exponential half-life; at equal similarity a recent episode wins. `recencyWeight: 0` → pure similarity. The similarity `threshold` still gates relevance (recency never surfaces an irrelevant-but-recent episode). `now` is injectable for deterministic tests.
- **procedural** — keeps a per-procedure use count; re-remembering (same `id`, or same text → same derived id) **reinforces** it with diminishing returns. Recall is side-effect-free.
- Each vector tier defaults to its own namespace (`ai.memory.semantic` / `.episodic` / `.procedural`) so they don't collide on a shared driver; override with `namespace`.

## The three methods

### `remember(items)`

```ts
await mem.remember({ text: "User is on the Enterprise plan.", tier: "semantic", metadata: { source: "crm" } });
await mem.remember([{ text: "a" }, { text: "b", tier: "working" }]);   // batch
```

A `MemoryItem` is `{ text, tier?, id?, metadata? }`. `text` is the only required field — it's what gets embedded (semantic) and surfaced back on recall. `tier` defaults to the factory `defaultTier`. Semantic items are embedded + indexed; working items append to the in-run buffer. **Re-remembering an item whose id (explicit or text-derived) already exists overwrites in place rather than duplicating.** `metadata` is an opaque bag round-tripped verbatim onto the recalled memory.

### `recall(query, options?)`

```ts
const hits = await mem.recall("which plan is the user on?", {
  k: 5,              // cap result count (defaults to factory k)
  threshold: 0.75,   // raise the semantic floor for this call
  tier: "semantic",  // restrict to one tier; omit to query every enabled tier
});

for (const hit of hits) {
  hit.id; hit.text; hit.tier; hit.score; hit.metadata;
}
```

Returns `RecalledMemory[]` scored and ordered by descending relevance. By default queries every enabled tier and merges. `score` is in `[0,1]` for **every** tier — cosine similarity (semantic), a recency proxy (working, most-recent = 1), similarity×recency (episodic), or similarity×reinforcement (procedural) — so a mixed recall set sorts on one field without special-casing the tier. Returns `[]` when nothing clears the threshold — never throws on "no hits".

**Memory never mutates the prompt.** `recall()` hands you scored entries; surfacing the recalled text (system prefix, a synthesized "what you remember" block, …) is YOUR call so the injection point stays explicit.

### `clear(tier?)`

```ts
await mem.clear();            // every tier
await mem.clear("working");   // just working — e.g. at session end, keeping durable recall
```

## Wiring into an orchestrator

Pass the store as `ai.orchestrator({ memory })` to recall before each turn's dispatch and remember the settled outcome after. Recalled memories land in `ctx.context[injectKey]` (default `"memories"`). See [`@warlock.js/ai/run-orchestrator/SKILL.md`](@warlock.js/ai/run-orchestrator/SKILL.md) for the per-turn `memory` field, `recall.k: 0` (write-only), `remember: false` (read-only), and `rememberTier`.

## Picking a vector driver

The semantic tier delegates similarity entirely to the `CacheDriver`:
- **Dev / tests** — `new MemoryCacheDriver()` (zero config, O(N) scan; fine up to a few thousand entries).
- **Production** — a driver with a real ANN index: `pg` with pgvector, `redis` with RediSearch.

Drivers without similarity support throw `CacheUnsupportedError` from `set({ vector })` / `similar()`. See [`@warlock.js/cache/cache-basics/SKILL.md`](@warlock.js/cache/cache-basics/SKILL.md).

## See also

- [`@warlock.js/ai/run-orchestrator/SKILL.md`](@warlock.js/ai/run-orchestrator/SKILL.md) — the `memory` field on a session
- [`@warlock.js/ai/embed-text/SKILL.md`](@warlock.js/ai/embed-text/SKILL.md) — the embedder the semantic tier needs
- [`@warlock.js/ai/attach-ai-middleware/SKILL.md`](@warlock.js/ai/attach-ai-middleware/SKILL.md) — `semanticCache`, the sibling `.similar()` consumer
- [`@warlock.js/cache/cache-basics/SKILL.md`](@warlock.js/cache/cache-basics/SKILL.md) — vector driver catalog
