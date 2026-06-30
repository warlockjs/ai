import type { MemoryContract } from "../../contracts/memory/memory.contract";
import type { ProceduralMemoryConfig } from "../../contracts/memory/memory-config.type";
import { memory } from "../../memory";
import type {
  SkillCatalogEntry,
  SkillRecord,
} from "../contracts/skill-record.type";
import type { SkillsStoreContract } from "../contracts/skills-store.contract";

/**
 * Metadata a procedural memory carries to round-trip a skill. `recall()`
 * surfaces `metadata` verbatim, so the skill's identity (name, version,
 * provenance, description, tags) rides here while the procedure body lives
 * in the memory's `text`.
 */
type ProceduralSkillMeta = {
  /** Marks the record as a skill (vs. a plain procedure) so `list` can scope. */
  skill: true;
  /** Skill name — the catalog key (also the memory `id`). */
  name: string;
  /** Provenance flag round-tripped onto the SkillRecord. */
  type: "candidate" | "promoted";
  /** Catalog line. */
  description: string;
  /** Monotonic version — bumped on promote. */
  version: number;
  /** Optional scope tags. */
  tags?: string[];
};

/** A recalled skill entry — the procedure body plus its skill metadata. */
type ProceduralSkillEntry = { body: string; meta: ProceduralSkillMeta };

const RECALL_K = 1000;

/**
 * {@link SkillsStoreContract} backed by the procedural memory tier
 * (`ai.memory({ procedural })`). **The unification** the design calls for:
 * "promote a proven procedural memory to a named skill" and "save a
 * self-authored skill" are the SAME machinery — one store, two entry
 * points. No fifth `MemoryTier` is added; the existing `"procedural"` tier
 * is reused verbatim.
 *
 * - `saveCandidate` ⇒ `memory.remember({ tier: "procedural", metadata: { type: "candidate" } })`.
 * - `promote` ⇒ re-remembers the same id with `type: "promoted"` and
 *   `version + 1`, which the procedural tier reinforces (increments `uses`).
 * - `list` / `load` map `memory.recall(..., { tier: "procedural" })` ⇒
 *   `RecalledMemory[]` ⇒ `SkillCatalogEntry[]` / `SkillRecord`, filtering
 *   out inert candidates so they can never be catalogued or injected.
 *
 * @example
 * const store = proceduralSkillStore({ embedder, store: cacheDriver });
 * const lib = skills({ name: "learned", sources: [{ type: "store", store }], review: gate });
 */
export function proceduralSkillStore(
  config: ProceduralMemoryConfig & { name?: string; recallQuery?: string },
): SkillsStoreContract {
  const store: MemoryContract = memory({
    name: config.name ?? "skills.procedural",
    working: false,
    defaultTier: "procedural",
    procedural: {
      embedder: config.embedder,
      store: config.store,
      namespace: config.namespace,
      reinforcementWeight: config.reinforcementWeight,
    },
  });

  // The procedural tier recalls by similarity to a query; for a full
  // catalog listing we recall against a broad seed with a large `k` and a
  // zero floor so every stored skill comes back.
  const recallQuery = config.recallQuery ?? "skill procedure how-to";

  const recallAll = async (): Promise<ProceduralSkillEntry[]> => {
    const hits = await store.recall(recallQuery, {
      tier: "procedural",
      k: RECALL_K,
      threshold: 0,
    });

    return hits
      .map((hit) => ({ body: hit.text, meta: hit.metadata as ProceduralSkillMeta | undefined }))
      .filter((entry): entry is ProceduralSkillEntry => Boolean(entry.meta?.skill));
  };

  return {
    async list(scope?: { tags?: string[] }): Promise<SkillCatalogEntry[]> {
      const all = await recallAll();
      const wanted = scope?.tags;

      return all
        .filter((entry) => entry.meta.type !== "candidate")
        .filter((entry) => intersects(entry.meta.tags, wanted))
        .map((entry) => toCatalogEntry(entry.meta));
    },
    async load(name: string, version?: number): Promise<SkillRecord | undefined> {
      const all = await recallAll();
      const match = all.find((entry) => entry.meta.name === name);

      if (!match || match.meta.type === "candidate") {
        return undefined;
      }

      if (version !== undefined && match.meta.version !== version) {
        return undefined;
      }

      return toRecord(match.body, match.meta);
    },
    async saveCandidate(record: Omit<SkillRecord, "version" | "type">): Promise<SkillRecord> {
      const meta: ProceduralSkillMeta = {
        skill: true,
        name: record.name,
        type: "candidate",
        description: record.description,
        version: 0,
        tags: record.tags,
      };

      await store.remember({
        id: record.name,
        text: record.body,
        tier: "procedural",
        metadata: meta,
      });

      return { ...record, version: 0, type: "candidate" };
    },
    async promote(name: string): Promise<SkillRecord> {
      const all = await recallAll();
      const match = all.find((entry) => entry.meta.name === name);

      if (!match) {
        throw new Error(`proceduralSkillStore.promote: no skill named "${name}" to promote`);
      }

      const meta: ProceduralSkillMeta = {
        ...match.meta,
        type: "promoted",
        version: match.meta.version + 1,
      };

      // Re-remembering the same id reinforces (uses++) AND flips the
      // metadata — the procedural tier's reinforcement IS the promotion.
      await store.remember({
        id: name,
        text: match.body,
        tier: "procedural",
        metadata: meta,
      });

      return toRecord(match.body, meta);
    },
  };
}

function toCatalogEntry(meta: ProceduralSkillMeta): SkillCatalogEntry {
  return {
    name: meta.name,
    description: meta.description,
    version: meta.version,
    tags: meta.tags,
    type: meta.type,
  };
}

function toRecord(body: string, meta: ProceduralSkillMeta): SkillRecord {
  return {
    name: meta.name,
    description: meta.description,
    version: meta.version,
    body,
    tags: meta.tags,
    type: meta.type,
  };
}

function intersects(recordTags: string[] | undefined, wanted: string[] | undefined): boolean {
  if (!wanted || wanted.length === 0) {
    return true;
  }

  if (!recordTags || recordTags.length === 0) {
    return false;
  }

  return recordTags.some((tag) => wanted.includes(tag));
}
