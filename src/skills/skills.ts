import type { AgentToolEntry } from "../tool/executable-as-tool";
import {
  buildCatalog,
  loadRecord,
  renderCatalogPrompt,
  semanticPreselect,
} from "./catalog";
import type {
  SkillAnalyticsEvent,
  SkillsConfig,
} from "./contracts/skills-config.type";
import type {
  SkillCatalogEntry,
  SkillRecord,
} from "./contracts/skill-record.type";
import type { SkillsContract } from "./contracts/skills.contract";
import type { SkillsStoreContract } from "./contracts/skills-store.contract";
import { loadSkillTool } from "./load-skill-tool";
import { saveSkillTool } from "./save-skill-tool";
import { resolveSource } from "./sources";

const DEFAULT_MAX_LOADS_PER_RUN = 5;

/**
 * Create a runtime skills library — the **mechanism** behind the
 * first-class `skills` agent option.
 *
 * The returned {@link SkillsContract} produces the agent-facing wiring:
 * - `catalog` / `catalogPrompt` — the always-injected cheap metadata block
 *   (one line per in-scope, non-candidate skill).
 * - `preload` — the bodies to inject up front per `inject` (`[]` when
 *   `inject` is omitted — the default catalog-only progressive disclosure).
 * - `tools(runId)` — the `loadSkill` tool always; plus `saveSkill` ONLY
 *   when a `review` gate is configured (otherwise self-authoring is inert).
 *
 * Sources are merged in order; a later source wins on a name collision.
 * `maxLoadsPerRun` (default 5) caps `loadSkill` calls per run; exhaustion
 * is an error RESULT the model self-corrects from, never a throw.
 *
 * @example
 * const lib = skills({
 *   name: "build-skills",
 *   sources: [{ type: "directory", path: "./agent-skills" }],
 *   inject: { select: "semantic", topK: 2, embedder },
 *   maxLoadsPerRun: 4,
 *   scope: { tags: ["frontend"] },
 * });
 */
export function skills(config: SkillsConfig): SkillsContract {
  if (!config.sources || config.sources.length === 0) {
    throw new Error(
      `skills("${config.name}"): at least one source is required (directory / url / store)`,
    );
  }

  const stores: SkillsStoreContract[] = config.sources.map(resolveSource);
  const scope = config.scope;
  const maxLoadsPerRun = config.maxLoadsPerRun ?? DEFAULT_MAX_LOADS_PER_RUN;
  const reviewExposed = config.review !== undefined;

  /** Fire an analytics event, swallowing any sink error (mirrors agent hooks). */
  const emit = (event: SkillAnalyticsEvent): void => {
    if (!config.analytics) {
      return;
    }

    try {
      void Promise.resolve(config.analytics(event)).catch(() => undefined);
    } catch {
      // Sink threw synchronously — swallowed; analytics never crash a run.
    }
  };

  const catalog = async (): Promise<SkillCatalogEntry[]> => {
    const entries = await buildCatalog(stores, scope);

    for (const entry of entries) {
      emit({ type: "catalogued", skill: entry.name, version: entry.version });
    }

    return entries;
  };

  return {
    name: config.name,

    catalog,

    async catalogPrompt(): Promise<string> {
      const entries = await catalog();

      return renderCatalogPrompt(config.name, entries);
    },

    async preload(input: string): Promise<SkillRecord[]> {
      if (!config.inject) {
        return [];
      }

      if (config.inject === "all") {
        const entries = await buildCatalog(stores, scope);
        const records: SkillRecord[] = [];

        for (const entry of entries) {
          const record = await loadRecord(stores, entry.name, entry.version);

          if (record) {
            records.push(record);
          }
        }

        return records;
      }

      // `{ select: "semantic", topK }`
      return semanticPreselect(stores, input, config.inject.topK, {
        embedder: config.inject.embedder,
        threshold: config.inject.threshold,
        scope,
      });
    },

    tools(runId?: string): AgentToolEntry<any, any>[] {
      const entries: AgentToolEntry<any, any>[] = [
        loadSkillTool({
          load: (name, version) => loadRecord(stores, name, version),
          maxLoadsPerRun,
          onLoaded: (record) =>
            emit({ type: "loaded", skill: record.name, version: record.version, runId }),
        }),
      ];

      // Phase 2 — `saveSkill` is exposed ONLY when a review gate is wired.
      // Absent gate ⇒ self-authoring is inert: the tool is never registered
      // and a candidate can never be written, let alone injected.
      if (reviewExposed && config.review) {
        const reviewStore = config.review.store;

        entries.push(
          saveSkillTool({
            saveCandidate: (record) => reviewStore.saveCandidate(record),
            onSaved: (record) =>
              emit({ type: "saved", skill: record.name, version: record.version, runId }),
          }),
        );
      }

      return entries;
    },
  };
}
