import type { CacheDriver } from "@warlock.js/cache";
import { resolveDefaultStore } from "../../config";
import type { Message } from "../../contracts/conversation-message.type";
import type { EmbedderContract } from "../../contracts/embedder.contract";
import type { AgentMiddleware } from "../../contracts/middleware";
import type { MiddlewareTripContext } from "../../contracts/middleware/middleware-context.type";
import type { ModelResponse } from "../../contracts/model.contract";
import { extractUserText } from "../utils";

/**
 * Isolation boundary for cache reads and writes.
 *
 * - `"session"` (default) — key every entry off the run's
 *   `AgentExecuteOptions.sessionId`, so one session never receives a
 *   response cached for another. Calls made WITHOUT a `sessionId` share
 *   one unscoped pool (the pre-4.15.0 behavior); an unscoped read never
 *   sees a session-scoped entry and vice versa.
 * - `"shared"` — one pool for every caller, regardless of session. The
 *   explicit opt-in for genuinely public Q&A (docs bots, FAQ) where the
 *   cross-user hit rate is the point and no response can carry one
 *   caller's private context.
 * - a resolver — derive the key yourself, e.g. per tenant
 *   (`ctx => ctx.options?.toolCtx?.tenantId`). Returning `undefined`
 *   falls back to the unscoped pool, so return a constant sentinel (or
 *   throw) if you need the call to fail closed instead.
 */
export type SemanticCacheScope =
  | "session"
  | "shared"
  | ((context: MiddlewareTripContext) => string | undefined);

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
   * Per-caller isolation boundary. Default `"session"` — a cached
   * response is served back only to the session that produced it.
   *
   * A `semanticCache` is normally built once at app boot and shared by
   * every end user, and a hit is returned as the model's answer with no
   * LLM call in between; without a scope that pools every caller's Q&A
   * pairs into one namespace, which is both a disclosure path (user B's
   * near-enough prompt gets served user A's answer, personal context
   * included) and a poisoning path (an attacker seeds an entry near a
   * predictable future query). Set `"shared"` to opt back into pooling
   * where that is actually desirable. See {@link SemanticCacheScope}.
   */
  scope?: SemanticCacheScope;
  /**
   * Middleware name — also the state-bag key prefix inside a single
   * execution. Default `"semantic-cache"`.
   */
  name?: string;
};

type CachedEntry = {
  response: ModelResponse;
  storedAt: number;
  /**
   * Isolation key the entry was written under; absent = the unscoped
   * pool (also the shape of every entry written before 4.15.0).
   */
  scope?: string;
};

type PendingWrite = {
  promptKey: string;
  vector: number[];
  scope?: string;
};

const DEFAULT_NAMESPACE = "ai.cache";

/**
 * Extra candidates pulled from `similar()` on a SCOPED lookup before the
 * scope filter runs. The driver ranks across every scope in the index,
 * so a bare `topK: 1` can come back as a foreign entry and mask this
 * scope's own legitimate hit. Mirrors the memory tiers' overscan.
 */
const SIMILAR_OVERSCAN = 5;

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
  return fnv1a(
    messages
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
      .join("||"),
  );
}

/** FNV-1a over a string — see {@link hashPrompt} for the caveats. */
function fnv1a(serialized: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < serialized.length; index++) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16);
}

/**
 * Resolve the isolation key this trip reads and writes under.
 *
 * Derived from the run's own `sessionId` (or the developer's resolver) —
 * never from the prompt, the model's output, or anything the LLM can
 * write to. `"shared"` and an unidentified run both resolve to
 * `undefined`, i.e. the unscoped pool, which a scoped lookup can never
 * read.
 */
function resolveScope(
  scope: SemanticCacheScope,
  context: MiddlewareTripContext,
): string | undefined {
  if (scope === "shared") {
    return undefined;
  }

  const key =
    typeof scope === "function"
      ? scope(context)
      : sessionScope(context.options?.sessionId);

  return key ? key : undefined;
}

/**
 * The default `"session"` key: the session id under a reserved prefix so
 * a custom resolver returning a bare tenant id can't collide with a
 * session pool. Mirrors the orchestrator's `sessionMemoryScope`.
 */
function sessionScope(sessionId: string | undefined): string | undefined {
  return sessionId ? `session:${sessionId}` : undefined;
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
 * **Per-session scoping (4.15.0).** One `semanticCache` instance
 * normally serves every end user, and a hit is returned as the answer
 * with no model call in between — so entries are keyed by the run's
 * `sessionId` (`scope`, default `"session"`) and a lookup only ever
 * sees entries written under the same key. Runs made without a
 * `sessionId` share one unscoped pool; pass `sessionId` on
 * `agent.execute()` (composites thread their own through automatically)
 * to get the isolation, or set `scope: "shared"` to pool deliberately.
 * Note the cost/benefit shift: scoping trades cross-user hit rate for
 * isolation, so public-FAQ deployments where no response can carry a
 * caller's private context should opt into `"shared"` explicitly.
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
  const scopeMode: SemanticCacheScope = options.scope ?? "session";
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
  //
  // A scoped entry gets an extra hashed segment, so two sessions asking
  // the identical question stay two entries instead of overwriting each
  // other; the scope is hashed because a `sessionId` is caller-supplied
  // and may contain the key delimiter. The unscoped key shape is
  // unchanged, so pre-4.15.0 entries still resolve. The hash is a
  // write-separation device only — a read is authorized by the exact
  // `entry.scope` equality check below, so even a hash collision cannot
  // widen what a session can read.
  const keyFor = (hash: string, scope: string | undefined): string =>
    scope === undefined
      ? `${namespace}.${hash}`
      : `${namespace}.${fnv1a(scope)}.${hash}`;

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

        const scope = resolveScope(scopeMode, context);
        const promptKey = hashPrompt(context.messages);

        const exact = await store.get<CachedEntry>(keyFor(promptKey, scope));

        // The key already carries the scope; re-checking the stored
        // `scope` is the actual authorization step, so a key collision
        // or a hand-written entry can't serve across the boundary.
        if (exact && exact.scope === scope && isFresh(exact, options.ttlMs)) {
          return toSyntheticResponse(exact.response);
        }

        const query = await options.embedder.embed(promptText);

        const hits = await store.similar<CachedEntry>(query.vector, {
          topK: scope === undefined ? 1 : SIMILAR_OVERSCAN,
          threshold: options.threshold,
        });

        // Only entries written inside this cache's namespace AND this
        // caller's scope are eligible. A shared driver would otherwise
        // leak a foreign namespace's entries; a shared namespace would
        // leak another session's answer to this one.
        const hit = hits.find(
          (candidate) =>
            candidate.key.startsWith(`${namespace}.`) &&
            candidate.value?.scope === scope &&
            isFresh(candidate.value, options.ttlMs),
        );

        if (hit) {
          return toSyntheticResponse(hit.value.response);
        }

        const pending: PendingWrite = {
          promptKey,
          vector: query.vector,
          scope,
        };
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

        const entry: CachedEntry = {
          response,
          storedAt: Date.now(),
          scope: pending.scope,
        };

        await store.set(keyFor(pending.promptKey, pending.scope), entry, {
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
