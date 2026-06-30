import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ToolContract } from "../tool/tool";
import { tool } from "../tool/tool";
import type { RetrieveOptions, RetrieveResult } from "./contracts/citation.type";
import type { RagAsToolOptions } from "./contracts/rag-config.type";

/** The validated input shape of a rag tool. */
type RagToolInput = { query: string };

/**
 * A minimal, schema-library-agnostic Standard Schema for `{ query: string }`.
 *
 * Built by hand (no `seal` / `zod` import) so `asTool()` stays dependency-
 * free and matches the framework's own `passthroughSchema` style — the
 * `~standard.validate` returns `{ issues }` on a bad shape so the tool
 * runtime surfaces a `SchemaValidationError` exactly like any other tool.
 */
function ragToolSchema(): StandardSchemaV1<RagToolInput> {
  return {
    "~standard": {
      version: 1,
      vendor: "warlock-ai-rag",
      validate: (value: unknown) => {
        if (
          !value ||
          typeof value !== "object" ||
          typeof (value as { query?: unknown }).query !== "string"
        ) {
          return {
            issues: [{ message: "rag tool input must be { query: string }" }],
          };
        }

        return { value: { query: (value as RagToolInput).query } };
      },
    },
  };
}

/**
 * Build a `ToolContract<{ query: string }, RetrieveResult>` that exposes a
 * rag's `retrieve()` to an agent's `tools: []` loop.
 *
 * `retrieve()` is a leaf operation (no inner executable report to nest),
 * so the plain `tool()` factory is the right shape — not `compositeAsTool`.
 * The resulting contract has `invoke`, so `isExecutableTool` returns false
 * and `normalizeAgentTools` passes it through untouched. On a thrown
 * retrieval error the runtime serializes `{ error }` back to the agent for
 * self-correction; the run does not abort.
 *
 * The tool name defaults to `retrieve_<name>` — namespaced by the rag's
 * name because the agent tool surface has no duplicate-name collision
 * guard (first match wins silently).
 */
export function ragAsTool(
  name: string,
  retrieveFn: (query: string, options?: RetrieveOptions) => Promise<RetrieveResult>,
  options: RagAsToolOptions = {},
): ToolContract<RagToolInput, RetrieveResult> {
  const toolName = options.name ?? `retrieve_${name}`;

  return tool<RagToolInput, RetrieveResult>({
    name: toolName,
    description:
      options.description ??
      `Search the "${name}" knowledge base and return the most relevant cited passages for a query.`,
    input: ragToolSchema(),
    execute: async ({ query }) => retrieveFn(query, options.retrieve),
  });
}
