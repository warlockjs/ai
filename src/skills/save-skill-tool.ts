import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ToolContract } from "../tool/tool";
import { tool } from "../tool/tool";
import type { SkillRecord } from "./contracts/skill-record.type";

/** Validated input of the `saveSkill` tool. */
export type SaveSkillInput = {
  name: string;
  description: string;
  body: string;
  tags?: string[];
};

/** Result the `saveSkill` tool feeds back to the model. */
export type SaveSkillResult =
  | { saved: true; name: string; status: "candidate" }
  | { error: string };

/**
 * Hand-built Standard Schema for the `saveSkill` input — dependency-free,
 * mirroring `loadSkillSchema`. Requires `name` / `description` / `body`;
 * `tags` is an optional string array.
 */
function saveSkillSchema(): StandardSchemaV1<SaveSkillInput> {
  return {
    "~standard": {
      version: 1,
      vendor: "warlock-ai-skills",
      validate: (value: unknown) => {
        const candidate = value as
          | { name?: unknown; description?: unknown; body?: unknown; tags?: unknown }
          | null;

        if (
          !candidate ||
          typeof candidate.name !== "string" ||
          typeof candidate.description !== "string" ||
          typeof candidate.body !== "string"
        ) {
          return {
            issues: [
              {
                message:
                  "saveSkill input must be { name: string; description: string; body: string; tags?: string[] }",
              },
            ],
          };
        }

        if (
          candidate.tags !== undefined &&
          (!Array.isArray(candidate.tags) ||
            !candidate.tags.every((tag) => typeof tag === "string"))
        ) {
          return { issues: [{ message: "saveSkill `tags` must be a string[] when provided" }] };
        }

        return {
          value: {
            name: candidate.name,
            description: candidate.description,
            body: candidate.body,
            ...(candidate.tags !== undefined ? { tags: candidate.tags as string[] } : {}),
          },
        };
      },
    },
  };
}

/** Dependencies the `saveSkill` tool closes over. */
export type SaveSkillToolDeps = {
  /** Write an INERT candidate; the returned record is `type: "candidate"`. */
  saveCandidate: (record: Omit<SkillRecord, "version" | "type">) => Promise<SkillRecord>;
  /** Fired on a successful save (`type: "saved"`); errors swallowed by the sink wrapper. */
  onSaved?: (record: SkillRecord) => void;
};

/**
 * Build the **Phase 2** `saveSkill` tool — exposed ONLY when a `review`
 * gate is configured. It writes an INERT `type: "candidate"` record via
 * `saveCandidate`. A candidate is filtered out of the catalog and from
 * preload — it can NEVER be injected until the default-DENY review gate
 * promotes it. So `saveSkill` alone can never turn the model's own output
 * into an injected instruction; promotion is a separate, gated step.
 *
 * `execute` never throws — a store write failure surfaces as an error
 * result so the run continues.
 */
export function saveSkillTool(deps: SaveSkillToolDeps): ToolContract<SaveSkillInput, SaveSkillResult> {
  return tool<SaveSkillInput, SaveSkillResult>({
    name: "saveSkill",
    description:
      "Propose a new reusable skill. The skill is saved as an INERT candidate and is NOT used until a reviewer approves it — it will not affect the current run.",
    input: saveSkillSchema(),
    execute: async (input) => {
      try {
        const record = await deps.saveCandidate({
          name: input.name,
          description: input.description,
          body: input.body,
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
        });

        deps.onSaved?.(record);

        return { saved: true, name: record.name, status: "candidate" };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}
