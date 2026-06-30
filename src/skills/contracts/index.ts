/**
 * Skills contracts — the public data shapes + interfaces consumers type
 * against. The `skills(config)` factory that produces a {@link SkillsContract}
 * lives at `src/skills/skills.ts`; sources and stores live in their
 * respective sub-folders.
 */

// Runtime contract
export type { SkillsContract } from "./skills.contract";

// Config + sources + gate + analytics
export type {
  SkillsConfig,
  SkillSource,
  SkillInjectMode,
  SkillReviewGate,
  SkillAnalyticsEvent,
} from "./skills-config.type";

// Store
export type { SkillsStoreContract } from "./skills-store.contract";

// Records
export type {
  SkillRecord,
  SkillCatalogEntry,
  LoadSkillInput,
} from "./skill-record.type";
