/**
 * The parsed front-matter + body of a single runtime skill, as loaded
 * from a {@link SkillSource}.
 *
 * A skill is **text injected into an agent's context** — it never runs
 * code. The cheap metadata (`name` + `description`) is what the catalog
 * surfaces up front; the full `body` is withheld until a `loadSkill`
 * tool call (progressive disclosure) or a semantic pre-injection pulls it.
 */
export type SkillRecord = {
  /** Stable slug — the `SKILL.md` folder name (or store key). */
  name: string;
  /** Single-line `description:` from the SKILL.md front-matter. The catalog line. */
  description: string;
  /** Monotonic version; a self-authored promotion bumps this. Defaults to 1. */
  version: number;
  /** The full SKILL.md body (front-matter stripped) — loaded on demand. */
  body: string;
  /** Optional role / context tags used by `scope` filtering. */
  tags?: string[];
  /** Provenance — authored on disk, in a store, or self-written then promoted. */
  type: "authored" | "promoted" | "candidate";
  /** Opaque per-skill metadata round-tripped onto analytics events. */
  metadata?: Record<string, unknown>;
};

/**
 * Cheap catalog entry — `body` deliberately absent (progressive
 * disclosure). The structural omission of `body` is the type-level
 * guarantee that the catalog never carries skill bodies.
 */
export type SkillCatalogEntry = Pick<
  SkillRecord,
  "name" | "description" | "version" | "tags" | "type"
>;

/**
 * Validated input of the `loadSkill` tool — a skill `name` plus an
 * optional pinned `version`. Standard Schema, never zod-specific (the
 * schema is hand-built so the skills feature stays dependency-free).
 */
export type LoadSkillInput = { name: string; version?: number };
