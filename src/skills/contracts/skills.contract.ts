import type { AgentToolEntry } from "../../tool/executable-as-tool";
import type { SkillCatalogEntry, SkillRecord } from "./skill-record.type";

/**
 * The runtime produced by the `skills(config)` factory. Its only job is
 * to produce the **agent-facing wiring** — a system-prompt prefix (the
 * catalog) plus the `loadSkill` (and, Phase 2, `saveSkill`) tools. This
 * contract is the underlying mechanism; the supported way to attach it is
 * the first-class `skills` key on `ai.agent`, which drives these same
 * methods for you with the run input at execute time.
 *
 * @example
 * const lib = skills({ name: "build", sources: [{ type: "store", store }] });
 * const catalogBlock = await lib.catalogPrompt(input);
 * const skillTools = lib.tools(runId);
 */
export interface SkillsContract {
  /** Stable identifier — surfaced in analytics + the catalog system block. */
  readonly name: string;
  /**
   * The always-available catalog — cheap metadata (name/version/description/
   * tags) for every in-scope, non-candidate skill. `scopeInput` is reserved
   * for future input-aware catalog filtering; it does not narrow today.
   */
  catalog(scopeInput?: string): Promise<SkillCatalogEntry[]>;
  /** Render the catalog as a system-prompt instruction string, ready to prepend. */
  catalogPrompt(scopeInput?: string): Promise<string>;
  /**
   * The skill tools the `skills` agent option auto-registers: `loadSkill`
   * always, plus `saveSkill` when a `review` gate is configured. `runId`
   * scopes the per-run `maxLoadsPerRun` budget and analytics correlation.
   */
  tools(runId?: string): AgentToolEntry<any, any>[];
  /**
   * Bodies to inject up front per `inject` — the full `SkillRecord`s the
   * caller prepends after the catalog. Returns `[]` when `inject` is omitted.
   */
  preload(input: string): Promise<SkillRecord[]>;
}
