import { resolveDefaultStore } from "../config";
import type { MemoryConfig } from "../contracts/memory/memory-config.type";
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
 * Decay / forgetting (TTL-based falloff, eviction) remains deferred.
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
  const workingEnabled = config.working ?? true;
  const defaultK = config.k ?? DEFAULT_K;
  const defaultThreshold = config.threshold ?? DEFAULT_THRESHOLD;

  const working = workingEnabled ? new WorkingMemory() : undefined;

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

      const [workingHits, semanticHits, episodicHits, proceduralHits] =
        await Promise.all([
          working && wants("working")
            ? Promise.resolve(working.recall(k))
            : Promise.resolve([] as RecalledMemory[]),
          semantic && wants("semantic")
            ? semantic.recall(query, k, threshold)
            : Promise.resolve([] as RecalledMemory[]),
          episodic && wants("episodic")
            ? episodic.recall(query, k, threshold)
            : Promise.resolve([] as RecalledMemory[]),
          procedural && wants("procedural")
            ? procedural.recall(query, k, threshold)
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
