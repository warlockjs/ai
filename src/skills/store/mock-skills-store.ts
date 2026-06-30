import type {
  SkillCatalogEntry,
  SkillRecord,
} from "../contracts/skill-record.type";
import type { SkillsStoreContract } from "../contracts/skills-store.contract";

/**
 * In-memory {@link SkillsStoreContract} that ships with the package.
 *
 * Backs tests and small/ephemeral skill libraries with zero external
 * dependencies. Holds the **latest** record per skill name; `saveCandidate`
 * writes an INERT `type: "candidate"` (never injectable until promoted),
 * and `promote` flips it to `type: "promoted"` with a monotonic
 * `version + 1`.
 *
 * Construct via `new MockSkillsStore([...records])` — it is a concrete
 * test/utility store, not a factory-fronted runtime primitive, so `new`
 * is the public surface here.
 *
 * @example
 * const store = new MockSkillsStore([
 *   { name: "scaffold", description: "Scaffold a form", version: 1, body: "...", type: "authored" },
 * ]);
 * const lib = skills({ name: "build", sources: [{ type: "store", store }] });
 */
export class MockSkillsStore implements SkillsStoreContract {
  /** Latest record per skill name. */
  private readonly records = new Map<string, SkillRecord>();

  public constructor(seed: SkillRecord[] = []) {
    for (const record of seed) {
      this.records.set(record.name, { ...record });
    }
  }

  /**
   * List the cheap catalog metadata for every NON-candidate skill,
   * optionally filtered to those whose `tags` intersect `scope.tags`.
   * Candidates are filtered out — they can never be catalogued or injected.
   */
  public async list(scope?: { tags?: string[] }): Promise<SkillCatalogEntry[]> {
    const wanted = scope?.tags;

    return [...this.records.values()]
      .filter((record) => record.type !== "candidate")
      .filter((record) => intersects(record.tags, wanted))
      .map(toCatalogEntry);
  }

  /**
   * Load the full record for `name`. When `version` is given, returns the
   * record only if its version matches (pin); otherwise the latest. A
   * `candidate` is never returned here — it is inert until promoted.
   */
  public async load(name: string, version?: number): Promise<SkillRecord | undefined> {
    const record = this.records.get(name);

    if (!record || record.type === "candidate") {
      return undefined;
    }

    if (version !== undefined && record.version !== version) {
      return undefined;
    }

    return { ...record };
  }

  /**
   * Write an INERT candidate (`type: "candidate"`, `version: 0`). A
   * candidate is filtered out of `list()` / `load()` — it can never be
   * injected until a `review` gate promotes it.
   */
  public async saveCandidate(
    record: Omit<SkillRecord, "version" | "type">,
  ): Promise<SkillRecord> {
    const candidate: SkillRecord = {
      ...record,
      version: 0,
      type: "candidate",
    };

    this.records.set(candidate.name, candidate);

    return { ...candidate };
  }

  /**
   * Promote the stored candidate for `name` to a new monotonic version
   * (`type: "promoted"`, `version + 1`). Throws when there is no candidate
   * to promote — promotion of a non-existent skill is a programming error.
   */
  public async promote(name: string): Promise<SkillRecord> {
    const existing = this.records.get(name);

    if (!existing) {
      throw new Error(`MockSkillsStore.promote: no skill named "${name}" to promote`);
    }

    const promoted: SkillRecord = {
      ...existing,
      version: existing.version + 1,
      type: "promoted",
    };

    this.records.set(name, promoted);

    return { ...promoted };
  }
}

/** Project a full record down to its catalog entry (body omitted). */
function toCatalogEntry(record: SkillRecord): SkillCatalogEntry {
  return {
    name: record.name,
    description: record.description,
    version: record.version,
    tags: record.tags,
    type: record.type,
  };
}

/**
 * True when no filter tags are requested, or when the record carries at
 * least one of the requested tags. A tagless record matches only the
 * unfiltered case.
 */
function intersects(recordTags: string[] | undefined, wanted: string[] | undefined): boolean {
  if (!wanted || wanted.length === 0) {
    return true;
  }

  if (!recordTags || recordTags.length === 0) {
    return false;
  }

  return recordTags.some((tag) => wanted.includes(tag));
}
