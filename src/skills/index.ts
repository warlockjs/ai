/**
 * Runtime agent skills with progressive disclosure (theme A).
 *
 * `ai.skills(config)` builds a {@link SkillsContract} — the mechanism the
 * first-class `skills` agent option drives: an always-injected metadata
 * catalog plus an on-demand `loadSkill` tool, backed by directory / url /
 * store sources. Semantic pre-injection is opt-in (`inject`) and needs an
 * embedder only then; everything else is dependency-free.
 *
 * Phase 2 (gated, inert by default): self-authoring via `saveSkill` writing
 * INERT candidates, a default-DENY `review` gate that promotes to a new
 * audited version, and a procedural-memory-backed store unifying proven
 * procedural memories with named skills.
 */

// Factory
export { skills } from "./skills";

// Stores
export { MockSkillsStore } from "./store/mock-skills-store";
export { proceduralSkillStore } from "./store/procedural-skill-store";

// Tools
export { loadSkillTool } from "./load-skill-tool";
export type { LoadSkillResult, LoadSkillToolDeps } from "./load-skill-tool";
export { saveSkillTool } from "./save-skill-tool";
export type { SaveSkillInput, SaveSkillResult, SaveSkillToolDeps } from "./save-skill-tool";

// Review gate (Phase 2)
export { runReviewGate } from "./review-gate";
export type { ReviewOutcome } from "./review-gate";

// Sources (advanced — the factory resolves these for you)
export { directorySource, urlSource, storeSource, resolveSource } from "./sources";
export { parseFrontmatter, parseTags } from "./sources/parse-frontmatter";
export type { ParsedFrontmatter } from "./sources/parse-frontmatter";

// Catalog helpers (advanced)
export {
  buildCatalog,
  renderCatalogPrompt,
  loadRecord,
  semanticPreselect,
} from "./catalog";

// Contracts
export type { SkillsContract } from "./contracts/skills.contract";
export type {
  SkillsConfig,
  SkillSource,
  SkillInjectMode,
  SkillReviewGate,
  SkillAnalyticsEvent,
} from "./contracts/skills-config.type";
export type { SkillsStoreContract } from "./contracts/skills-store.contract";
export type {
  SkillRecord,
  SkillCatalogEntry,
  LoadSkillInput,
} from "./contracts/skill-record.type";
