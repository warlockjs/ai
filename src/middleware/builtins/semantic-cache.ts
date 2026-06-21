import type { CacheDriver } from "@warlock.js/cache";
import { resolveDefaultStore } from "../../config";
import type { Message } from "../../contracts/conversation-message.type";
import type { EmbedderContract } from "../../contracts/embedder.contract";
import type { AgentMiddleware } from "../../contracts/middleware";
import type { ModelResponse } from "../../contracts/model.contract";
import { extractUserText } from "../utils";

/**
 * Configuration for `semanticCache()`.
 */
export type SemanticCacheOptions = {
  /** Embedder used to produce the query vector from the prompt text. */
  embedder: EmbedderContract;
  /**
   * Vector-capable cache driver from `@warlock.js/cache`. Production
   * deployments pick a driver with a real ANN index (`pg` with
   * pgvector, `redis` with RediSearch). Dev / test environments use
   * `new MemoryCacheDriver()` — zero config, correct, but O(N) per
   * query. Drivers without similarity support throw
   * `CacheUnsupportedError` from `set({ vector })` / `similar()`.
   *
   * Falls back to `ai.config({ defaultStore })` when omitted. When
   * neither is set, the factory throws at construction time —
   * semantic cache cannot operate without a store.
   */
  store?: CacheDriver<any, any>;
  /**
   * Minimum cosine similarity for a vector hit. Between 0 and 1 —
   * 0.95 is a solid default for question-answering caches.
   */
  threshold: number;
  /**
   * Optional TTL in milliseconds. Entries whose `storedAt` is older
   * than this are treated as misses on read and overwritten on the
   * next write. Default: no expiry — entries live until the store
   * evicts them (per its own TTL/eviction policy).
   */
  ttlMs?: number;
  /**
   * Namespace prefix applied to every key the cache writes. Lets
   * multiple agents share one driver without collision. Default
   * `"ai.cache"`.
   */
  namespace?: string;
  /**
   * Middleware name — also the state-bag key prefix inside a single
   * execution. Default `"semantic-cache"`.
   */
  name?: string;
};

type CachedEntry = {
  response: ModelResponse;
  storedAt: number;
};

type PendingWrite = {
  promptKey: string;
  vector: number[];
};

const DEFAULT_NAMESPACE = "ai.cache";

/**
 * Build a stable fingerprint for a prompt covering the full message
 * list (system + history + user turn). Ensures two prompts sharing
 * the user text but differing in prior context do not collide on
 * the exact-match fast path.
 *
 * FNV-1a variant — cheap, collision-resistant enough for a cache,
 * dependency-free. NOT a cryptographic hash: collisions would
 * surface as wrong cache hits, not a security issue in the current
 * trust model.
 */
function hashPrompt(messages: ReadonlyArray<Message>): string {
  const serialized = messages
    .map((message) => {
      const role = message.role;
      const content = Array.isArray(message.content)
        ? message.content
            .filter((part) => part.type === "text")
            .map((part) => (part as { text: string }).text)
            .join("|")
        : message.content;

      return `${role}:${content}`;
    })
    .join("||");

  let hash = 0x811c9dc5;

  for (let index = 0; index < serialized.length; index++) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16);
}

function isFresh(entry: CachedEntry, ttlMs: number | undefined): boolean {
  if (ttlMs === undefined) {
    return true;
  }

  return Date.now() - entry.storedAt <= ttlMs;
}

/**
 * Semantic-similarity response cache for an agent run.
 *
 * **Role.** Skips LLM round-trips when the current prompt is
 * semantically close to one the agent has already answered. For
 * FAQ / support-style traffic this often eliminates 60–80% of
 * model calls — the production win is massive for cost and
 * latency.
 *
 * **Delegation to `@warlock.js/cache`.** This middleware does NOT
 * implement similarity search itself. It delegates to the supplied
 * `CacheDriver`. Production deployments pick a driver with an ANN
 * index (`pg` + pgvector, `redis` + RediSearch). Dev / test
 * environments pass `new MemoryCacheDriver()` — zero config, correct,
 * but O(N) per query. Drivers without similarity support throw
 * `CacheUnsupportedError` from `set({ vector })` / `similar()`.
 *
 * **Two-tier lookup.**
 * 1. *Exact-match key* — a cheap FNV hash over the entire message
 *    list. `store.get(hash)` returns the entry without an embedding
 *    round trip when the prompt hasn't changed at all.
 * 2. *Vector-match* — on exact-match miss, embed the prompt and
 *    call `store.similar(vector, { topK: 1, threshold })`. The
 *    driver uses its native similarity index; anything clearing
 *    `threshold` is returned as a hit.
 *
 * **Write-on-miss.** When both tiers miss, `trip.before` stashes
 * the prompt hash + vector in `ctx.state`; `trip.after` reads back
 * the pending entry and calls
 * `store.set(hash, entry, { vector })`. If an outer middleware
 * (guardrail) throws in `trip.after` before the cache's `trip.after`
 * runs, the pending entry is never written — bad responses stay out
 * of the cache **as long as the canonical install order is followed**
 * (cache outermost).
 *
 * **Synthetic-response on hit.** Returns a `ModelResponse` with
 * `usage: { input: 0, output: 0, total: 0 }` so budget /
 * observability correctly exclude the saved trip.
 *
 * @example
 * import { semanticCache } from "@warlock.js/ai";
 * import { MemoryCacheDriver } from "@warlock.js/cache";
 *
 * const store = new MemoryCacheDriver();
 * store.setOptions({});
 *
 * const cache = semanticCache({
 *   embedder: openai.embedder({ name: "text-embedding-3-small" }),
 *   store,
 *   threshold: 0.95,
 *   ttlMs: 60 * 60 * 1000,
 * });
 *
 * const myAgent = agent({ model, middleware: [cache] });
 */
export function semanticCache(options: SemanticCacheOptions): AgentMiddleware {
  const name = options.name ?? "semantic-cache";
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  const pendingKey = `${name}.pending`;

  // Resolve the effective store at factory time, not per-call. Every
  // subsequent hook closes over `store` so the resolution happens once.
  // Throws now (loud, at construction) instead of later during the
  // first trip (silent until the agent actually runs).
  const store = options.store ?? resolveDefaultStore();

  if (!store) {
    throw new Error(
      `semanticCache: no store supplied — pass \`store\` in options or call \`ai.config({ defaultStore })\` at app boot before constructing the middleware`,
    );
  }

  // Cache's parseKey replaces ":" with "." so the namespace boundary
  // matches what `similar()` actually returns in `hit.key`. Using a
  // dot here keeps prefix checks aligned with stored keys.
  const keyFor = (hash: string): string => `${namespace}.${hash}`;

  return {
    name,
    log: true,
    trip: {
      async before(context) {
        // Only cache the first trip's response. Subsequent trips
        // happen because the previous trip requested tool calls — the
        // message list now carries tool results the original prompt
        // never saw, so a semantic match on the unchanged user text
        // would serve back the prior `tool_calls` response and loop
        // the agent forever. The first turn is also the only one
        // where a "same question → same final answer" caching story
        // is sound.
        if (context.tripIndex !== 0) {
          return;
        }

        const promptText = extractUserText(context.messages);

        if (!promptText) {
          return;
        }

        const promptKey = hashPrompt(context.messages);
        const scopedKey = keyFor(promptKey);

        const exact = await store.get<CachedEntry>(scopedKey);

        if (exact && isFresh(exact, options.ttlMs)) {
          return toSyntheticResponse(exact.response);
        }

        const query = await options.embedder.embed(promptText);

        const [hit] = await store.similar<CachedEntry>(query.vector, {
          topK: 1,
          threshold: options.threshold,
        });

        if (hit && isFresh(hit.value, options.ttlMs)) {
          // Only return hits whose stored key is within this cache's
          // namespace. Drivers shared across namespaces would otherwise
          // leak foreign entries into queries.
          if (hit.key.startsWith(`${namespace}.`)) {
            return toSyntheticResponse(hit.value.response);
          }
        }

        const pending: PendingWrite = { promptKey, vector: query.vector };
        context.state.set(pendingKey, pending);

        return;
      },
      async after(context, response) {
        const pending = context.state.get(pendingKey) as PendingWrite | undefined;

        if (!pending) {
          return;
        }

        // Mid-stream tool-call responses must not be cached — the
        // useful answer comes from the trip *after* the tool returns.
        // Crucially, leave the pending entry in place so a later trip
        // (the one that actually finishes with `stop`) can read it
        // and write the final response under the *original* trip-0
        // prompt key. Deleting here would orphan the pending and the
        // post-tool answer would never make it into the store.
        if (response.finishReason === "tool_calls") {
          return;
        }

        context.state.delete(pendingKey);

        const entry: CachedEntry = { response, storedAt: Date.now() };

        await store.set(keyFor(pending.promptKey), entry, {
          vector: pending.vector,
        });

        return;
      },
    },
  };
}

function toSyntheticResponse(response: ModelResponse): ModelResponse {
  return {
    content: response.content,
    finishReason: response.finishReason,
    usage: { input: 0, output: 0, total: 0 },
    toolCalls: response.toolCalls,
  };
}
