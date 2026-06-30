import type { SkillCatalogEntry, SkillRecord } from "./skill-record.type";

/**
 * Provider-neutral contract for a skills backing store.
 *
 * Every {@link SkillSource} resolves to one of these readers; the
 * `skills(...)` factory merges several of them. `list` powers the cheap
 * catalog; `load` powers on-demand body fetch. `saveCandidate` / `promote`
 * are the **Phase 2** self-authoring half — they write/promote candidates
 * but are inert until a `review` gate is wired (a candidate can never be
 * injected).
 */
export interface SkillsStoreContract {
  /** Cheap metadata listing — names/descriptions/versions, never bodies. */
  list(scope?: { tags?: string[] }): Promise<SkillCatalogEntry[]>;
  /** Full record for one skill (latest, or a pinned `version`); `undefined` when unknown. */
  load(name: string, version?: number): Promise<SkillRecord | undefined>;
  /** Phase 2 — writes an INERT candidate (`type: "candidate"`). Never injectable. */
  saveCandidate(record: Omit<SkillRecord, "version" | "type">): Promise<SkillRecord>;
  /** Phase 2 — promotes a candidate to a new monotonic version (`type: "promoted"`). */
  promote(name: string): Promise<SkillRecord>;
}
