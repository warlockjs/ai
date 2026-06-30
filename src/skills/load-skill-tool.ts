import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ToolContract } from "../tool/tool";
import { tool } from "../tool/tool";
import type {
  LoadSkillInput,
  SkillRecord,
} from "./contracts/skill-record.type";

/** Result the `loadSkill` tool feeds back to the model. */
export type LoadSkillResult =
  | { body: string; name: string; version: number }
  | { error: string };

/**
 * Hand-built, schema-library-agnostic Standard Schema for
 * `{ name: string; version?: number }` — built without `seal` / `zod` so
 * the skills feature stays dependency-free, matching the framework's own
 * `ragToolSchema` style. Bad shapes return `{ issues }` so the tool
 * runtime surfaces a `SchemaValidationError` like any other tool.
 */
function loadSkillSchema(): StandardSchemaV1<LoadSkillInput> {
  return {
    "~standard": {
      version: 1,
      vendor: "warlock-ai-skills",
      validate: (value: unknown) => {
        const candidate = value as { name?: unknown; version?: unknown } | null;

        if (!candidate || typeof candidate.name !== "string") {
          return { issues: [{ message: "loadSkill input must be { name: string; version?: number }" }] };
        }

        if (candidate.version !== undefined && typeof candidate.version !== "number") {
          return { issues: [{ message: "loadSkill `version` must be a number when provided" }] };
        }

        return {
          value: {
            name: candidate.name,
            ...(candidate.version !== undefined ? { version: candidate.version } : {}),
          },
        };
      },
    },
  };
}

/** Dependencies the `loadSkill` tool closes over — kept narrow for testing. */
export type LoadSkillToolDeps = {
  /** Resolve a skill's full record across the merged sources. */
  load: (name: string, version?: number) => Promise<SkillRecord | undefined>;
  /** Per-run budget cap on `loadSkill` calls (default 5, enforced by caller-supplied counter). */
  maxLoadsPerRun: number;
  /** Fired on each successful load (`type: "loaded"`); errors swallowed by the sink wrapper. */
  onLoaded?: (record: SkillRecord) => void;
};

/**
 * Build the `loadSkill` tool for one run. Returns the skill **body** as
 * the tool result, which the agent loop feeds straight back to the model
 * (the standard `role:"tool"` message path) — making the loaded procedure
 * visible on the next trip.
 *
 * The per-run counter is closed over here (one tool instance per run), so
 * the budget is naturally scoped to this execution:
 * - Past `maxLoadsPerRun` ⇒ returns `{ error: "skill load budget exhausted" }`
 *   as a RESULT, never a throw — the model self-corrects, exactly how the
 *   agent loop treats any tool error.
 * - Unknown skill (`load` ⇒ undefined) ⇒ `{ error: "unknown skill: <name>" }`.
 *
 * `execute` itself never throws — both failure modes are error results, so
 * the run continues.
 */
export function loadSkillTool(deps: LoadSkillToolDeps): ToolContract<LoadSkillInput, LoadSkillResult> {
  let loads = 0;

  return tool<LoadSkillInput, LoadSkillResult>({
    name: "loadSkill",
    description:
      "Load the full instructions of a named skill from the catalog into context. Call it with the skill's `name` (and optional `version`) when you need its detailed procedure.",
    input: loadSkillSchema(),
    execute: async ({ name, version }) => {
      if (loads >= deps.maxLoadsPerRun) {
        return { error: "skill load budget exhausted" };
      }

      loads += 1;

      const record = await deps.load(name, version);

      if (!record) {
        return { error: `unknown skill: ${name}` };
      }

      deps.onLoaded?.(record);

      return { body: record.body, name: record.name, version: record.version };
    },
  });
}
