import { resolveDefaultStore } from "../config";
import type {
  MemoryConfig,
  WorkingMemoryConfig,
} from "../contracts/memory/memory-config.type";
import type {
  MemoryItem,
  MemoryTier,
  RecalledMemory,
} from "../contracts/memory/memory-item.type";
import type { MemoryContract } from "../contracts/memory/memory.contract";
import type { RecallOptions } from "../contracts/memory/recall-options.type";
import { EpisodicMemory } from "./episodic-memory";
import { ProceduralMemory } from "./procedural-memory";
import { SemanticMemory } from "./semantic-memory";
import { WorkingMemory } from "./working-memory";

const DEFAULT_NAME = "memory";
const DEFAULT_SEMANTIC_NAMESPACE = "ai.memory.semantic";
const DEFAULT_EPISODIC_NAMESPACE = "ai.memory.episodic";
const DEFAULT_PROCEDURAL_NAMESPACE = "ai.memory.procedural";
const DEFAULT_K = 5;
const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_RECENCY_WEIGHT = 0.3;
const DEFAULT_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_REINFORCEMENT_WEIGHT = 0.3;

/**
 * Entries the in-process working buffer holds before it starts evicting
 * its oldest (4.15.0 — security fix for unbounded growth). Sized to hold
 * a deep multi-session scratch history while capping the tier's worst
 * case at a few MB of resident text rather than "everything this process
 * has ever been told."
 */
const DEFAULT_WORKING_MAX_ITEMS = 1000;

/**
 * Create an agent memory store (memory core M2).
 *
 * Wires up to four tiers behind the {@link MemoryContract}: **working**
 * (in-run scratch, recency), **semantic** (durable facts by cosine
 * similarity), **episodic** (durable events, similarity blended with
 * recency), and **procedural** (durable how-tos, similarity blended with
 * reinforcement). The working tier is on by default; the other three each
 * activate only when their config is supplied. The three vector tiers
 * mirror how `semanticCache` delegates similarity to the cache driver's
 * `.similar()`.
 *
 * Resolution happens once here, at construction (loud), rather than per
 * call (silent until first use): a vector-tier config with no `store` and
 * no `ai.config({ defaultStore })` throws now; enabling no tier at all
 * throws now.
 *
 * TTL-based decay / forgetting remains deferred. The working tier is
 * size-bounded (`working: { maxItems }`, default `1000`, oldest-written
 * evicted first) because it is the one tier that holds everything it is
 * told in process memory for the life of the instance; the durable tiers
 * delegate retention to their `CacheDriver`.
 *
 * **Isolation (4.15.0).** `remember({ scope })` / `recall(query, { scope })`
 * carry an opaque tenant / session key that every tier enforces as an
 * exact-equality filter before scoring — one scope's memories never
 * surface in another's recall, and identical text under two scopes stays
 * two entries. Unscoped writes form a shared pool that only an unscoped
 * recall can read; there is no "all scopes" query. `ai.orchestrator()`
 * derives this from the turn's `sessionId` automatically.
 *
 * @example
 * import { ai } from "@warlock.js/ai";
 * import { MemoryCacheDriver } from "@warlock.js/cache";
 *
 * const store = new MemoryCacheDriver();
 * store.setOptions({});
 *
 * const mem = ai.memory({
 *   semantic: { embedder, store },
 *   defaultTier: "semantic",
 * });
 *
 * await mem.remember({ text: "User prefers concise answers." });
 * const hits = await mem.recall("how should I respond?", { k: 3 });
 */
export function memory(config: MemoryConfig = {}): MemoryContract {
  const name = config.name ?? DEFAULT_NAME;
  const workingConfig = config.working ?? true;
  const defaultK = config.k ?? DEFAULT_K;
  const defaultThreshold = config.threshold ?? DEFAULT_THRESHOLD;

  const working =
    workingConfig === false
      ? undefined
      : new WorkingMemory(resolveWorkingMaxItems(workingConfig, name));

  const semantic = config.semantic
    ? buildSemanticTier(config.semantic, name)
    : undefined;

  const episodic = config.episodic
    ? buildEpisodicTier(config.episodic, name)
    : undefined;

  const procedural = config.procedural
    ? buildProceduralTier(config.procedural, name)
    : undefined;

  const tiers: Tiers = { working, semantic, episodic, procedural };

  if (!working && !semantic && !episodic && !procedural) {
    throw new Error(
      `memory("${name}"): no tier enabled — enable \`working\` (default) or pass a \`semantic\` / \`episodic\` / \`procedural\` config; a memory with no tiers can neither store nor recall`,
    );
  }

  const defaultTier: MemoryTier = config.defaultTier ?? "working";

  assertTierEnabled(defaultTier, tiers, name);

  return {
    name,
    async remember(items: MemoryItem | MemoryItem[]): Promise<void> {
      const list = Array.isArray(items) ? items : [items];

      const writes: Promise<void>[] = [];

      for (const item of list) {
        const tier = item.tier ?? defaultTier;

        assertTierEnabled(tier, tiers, name);

        if (tier === "working") {
          working!.remember(item);

          continue;
        }

        if (tier === "semantic") {
          writes.push(semantic!.remember(item));

          continue;
        }

        if (tier === "episodic") {
          writes.push(episodic!.remember(item));

          continue;
        }

        writes.push(procedural!.remember(item));
      }

      await Promise.all(writes);
    },
    async recall(
      query: string,
      options: RecallOptions = {},
    ): Promise<RecalledMemory[]> {
      const k = options.k ?? defaultK;
      const threshold = options.threshold ?? defaultThreshold;

      if (options.tier) {
        assertTierEnabled(options.tier, tiers, name);
      }

      const wants = (tier: MemoryTier): boolean =>
        !options.tier || options.tier === tier;

      // `options.scope` is the isolation key — each tier applies it as an
      // exact-equality filter internally, BEFORE its own scoring and
      // slicing, so nothing outside the scope reaches this merge.
      const scope = options.scope;

      const [workingHits, semanticHits, episodicHits, proceduralHits] =
        await Promise.all([
          working && wants("working")
            ? Promise.resolve(working.recall(k, scope))
            : Promise.resolve([] as RecalledMemory[]),
          semantic && wants("semantic")
            ? semantic.recall(query, k, threshold, scope)
            : Promise.resolve([] as RecalledMemory[]),
          episodic && wants("episodic")
            ? episodic.recall(query, k, threshold, scope)
            : Promise.resolve([] as RecalledMemory[]),
          procedural && wants("procedural")
            ? procedural.recall(query, k, threshold, scope)
            : Promise.resolve([] as RecalledMemory[]),
        ]);

      return [
        ...workingHits,
        ...semanticHits,
        ...episodicHits,
        ...proceduralHits,
      ]
        .sort((first, second) => second.score - first.score)
        .slice(0, k);
    },
    async clear(tier?: MemoryTier): Promise<void> {
      const clears: Promise<void>[] = [];

      if (working && (!tier || tier === "working")) {
        working.clear();
      }

      if (semantic && (!tier || tier === "semantic")) {
        clears.push(semantic.clear());
      }

      if (episodic && (!tier || tier === "episodic")) {
        clears.push(episodic.clear());
      }

      if (procedural && (!tier || tier === "procedural")) {
        clears.push(procedural.clear());
      }

      await Promise.all(clears);
    },
  };
}

/** The four tier instances a `memory()` composes; `undefined` when off. */
type Tiers = {
  working: WorkingMemory | undefined;
  semantic: SemanticMemory | undefined;
  episodic: EpisodicMemory | undefined;
  procedural: ProceduralMemory | undefined;
};

/**
 * Resolve the working tier's size bound from the `working` config
 * (`true` / a `{ maxItems }` object), validating it at construction the
 * same way every other tier's wiring fails loud-and-now rather than on
 * first use. There is deliberately no unbounded setting — the buffer is
 * process-resident for the life of the memory instance, so "no cap" is
 * a memory-exhaustion vector, not a configuration choice.
 */
function resolveWorkingMaxItems(
  workingConfig: true | WorkingMemoryConfig,
  name: string,
): number {
  const maxItems =
    workingConfig === true
      ? DEFAULT_WORKING_MAX_ITEMS
      : (workingConfig.maxItems ?? DEFAULT_WORKING_MAX_ITEMS);

  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new Error(
      `memory("${name}"): working tier \`maxItems\` must be an integer >= 1 — received ${String(maxItems)}`,
    );
  }

  return maxItems;
}

/**
 * Resolve the semantic tier's store (explicit `store` wins, else the
 * global `ai.config({ defaultStore })`) and build the tier. Throws at
 * construction when neither is available — the same loud-now contract
 * `semanticCache` follows.
 */
function buildSemanticTier(
  semanticConfig: NonNullable<MemoryConfig["semantic"]>,
  name: string,
): SemanticMemory {
  const store = semanticConfig.store ?? resolveDefaultStore();

  if (!store) {
    throw new Error(
      `memory("${name}"): semantic tier has no store — pass \`semantic.store\` or call \`ai.config({ defaultStore })\` at app boot before constructing the memory`,
    );
  }

  return new SemanticMemory(
    semanticConfig.embedder,
    store,
    semanticConfig.namespace ?? DEFAULT_SEMANTIC_NAMESPACE,
  );
}

/**
 * Resolve the episodic tier's store (explicit `store` wins, else the
 * global default) and build the tier with its recency knobs. Throws at
 * construction when neither store is available — the same loud-now
 * contract the semantic tier follows.
 */
function buildEpisodicTier(
  episodicConfig: NonNullable<MemoryConfig["episodic"]>,
  name: string,
): EpisodicMemory {
  const store = episodicConfig.store ?? resolveDefaultStore();

  if (!store) {
    throw new Error(
      `memory("${name}"): episodic tier has no store — pass \`episodic.store\` or call \`ai.config({ defaultStore })\` at app boot before constructing the memory`,
    );
  }

  return new EpisodicMemory(
    episodicConfig.embedder,
    store,
    episodicConfig.namespace ?? DEFAULT_EPISODIC_NAMESPACE,
    episodicConfig.recencyWeight ?? DEFAULT_RECENCY_WEIGHT,
    episodicConfig.halfLifeMs ?? DEFAULT_HALF_LIFE_MS,
    episodicConfig.now ?? (() => Date.now()),
  );
}

/**
 * Resolve the procedural tier's store and build the tier with its
 * reinforcement knob. Throws at construction when no store is available.
 */
function buildProceduralTier(
  proceduralConfig: NonNullable<MemoryConfig["procedural"]>,
  name: string,
): ProceduralMemory {
  const store = proceduralConfig.store ?? resolveDefaultStore();

  if (!store) {
    throw new Error(
      `memory("${name}"): procedural tier has no store — pass \`procedural.store\` or call \`ai.config({ defaultStore })\` at app boot before constructing the memory`,
    );
  }

  return new ProceduralMemory(
    proceduralConfig.embedder,
    store,
    proceduralConfig.namespace ?? DEFAULT_PROCEDURAL_NAMESPACE,
    proceduralConfig.reinforcementWeight ?? DEFAULT_REINFORCEMENT_WEIGHT,
  );
}

/**
 * Guard that a tier referenced by config / a call is actually enabled,
 * failing fast with an actionable message instead of a downstream
 * `undefined` dereference.
 */
function assertTierEnabled(tier: MemoryTier, tiers: Tiers, name: string): void {
  if (tier === "working" && !tiers.working) {
    throw new Error(
      `memory("${name}"): working tier is disabled — set \`working: true\` (the default) to use it`,
    );
  }

  if (tier === "semantic" && !tiers.semantic) {
    throw new Error(
      `memory("${name}"): semantic tier is not configured — pass \`semantic\` config to use it`,
    );
  }

  if (tier === "episodic" && !tiers.episodic) {
    throw new Error(
      `memory("${name}"): episodic tier is not configured — pass \`episodic\` config to use it`,
    );
  }

  if (tier === "procedural" && !tiers.procedural) {
    throw new Error(
      `memory("${name}"): procedural tier is not configured — pass \`procedural\` config to use it`,
    );
  }
}
