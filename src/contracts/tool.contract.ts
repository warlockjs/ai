import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Optional metadata attached to a tool for documentation and tooling.
 *
 * @example
 * const meta: ToolMeta = { category: "search", version: "1.0" };
 */
export type ToolMeta = Record<"label" | "actionLabel" | (string & {}), unknown>;

/**
 * Discriminated mode controlling whether the tool's result feeds back
 * to the model.
 *
 * - **`feedback`** (default) — standard tool behavior. The model emits
 *   a tool call, the agent dispatches the tool, the result is appended
 *   to the conversation as a `role: "tool"` message, and the agent
 *   makes another LLM trip so the model can read the result and
 *   respond. Use for tools whose output the model needs to narrate
 *   (search, lookup, classification with a reply that depends on it).
 *
 * - **`silent`** — fire-and-forget mechanics. The tool's *result* is
 *   not fed back to the model. When every tool call in a single
 *   generation is `silent`, the agent loop terminates after dispatch:
 *   the prose the model streamed alongside the tool call IS the final
 *   reply. Use for pure side-effect tools where the model already
 *   knows what to say before the tool runs (state mutations, locale
 *   pinning, topic classification updates, telemetry pings).
 *
 * **What "silent" applies to.** Strictly the LLM-feedback channel.
 * The tool itself runs to completion through middleware (logging,
 * cost tracking, telemetry) like any other — only the model-feedback
 * leg is closed.
 *
 * **Constraints for silent tools.** Should be cheap, idempotent, and
 * side-effect-only. No slow ops, no expensive network calls — the
 * customer is waiting on the prose stream that already finished, but
 * the request is still open until the silent tool resolves.
 *
 * **Mixed-mode trips.** If a single generation contains both
 * `feedback` and `silent` tool calls, the loop continues — the
 * feedback tool's result still needs to round-trip. The "all silent
 * → terminate" rule only kicks in when EVERY tool call is silent.
 */
export type ToolMode = "feedback" | "silent";

/**
 * Per-call context threaded into a tool handler as the optional second
 * argument (Phase 5 / decisions §35).
 *
 * **Role.** Carry system-only data that should NOT round-trip through
 * the LLM. The tool's `return` value is what the agent sees;
 * `ctx.artifacts` is what the system captures. Strict separation of
 * channels — neither leaks into the other.
 *
 * **Lifecycle.** When dispatched under a supervisor, the bag starts
 * empty at every iteration boundary, accumulates across all tool
 * calls in that iteration, and merges into supervisor state via
 * `artifactsSchema` / `finalizeArtifacts` at iteration end. When the
 * tool runs standalone (`tool.invoke(input)` without a ctx), a
 * degraded `{ artifacts: {} }` is supplied — mutations are harmless
 * no-ops.
 *
 * @example
 * ai.tool({
 *   name: "search_catalog",
 *   input: v.object({ query: v.string() }),
 *   execute: async (input, ctx) => {
 *     const items = await searchItems(input.query);
 *
 *     // Side-channel: blocks land in supervisor state, not the LLM.
 *     ctx.artifacts.blocks ??= [];
 *     ctx.artifacts.blocks.push({ type: "items", itemIds: items.map(i => i.id) });
 *
 *     // Return value: what the agent sees and reasons over.
 *     return { total: items.length };
 *   },
 * });
 */
export type ToolContext<TArtifacts = Record<string, unknown>> = {
  /**
   * Mutable bag for system-only data. Writes here never reach the
   * LLM. Shape is typed by the registering supervisor's
   * `artifactsSchema` when present; defaults to
   * `Record<string, unknown>` for tools used outside a supervisor.
   */
  artifacts: TArtifacts;
  /** Same signal threaded through dispatch — for cancellation-aware tools. */
  signal?: AbortSignal;
};

/**
 * Contract that every tool must implement.
 * Tools are callable functions exposed to the LLM during agent execution.
 *
 * @example
 * import { z } from "zod"; // or any Standard Schema compatible library
 *
 * const searchTool: ToolConfig<{ query: string }, { results: string[] }> = {
 *   name: "searchWeb",
 *   description: "Search the web for current information",
 *   input: z.object({ query: z.string() }),
 *   execute: async ({ query }) => ({ results: ["result1", "result2"] }),
 * };
 */
export interface ToolConfig<TInput = unknown, TOutput = unknown> {
  /** Unique tool name exposed to the LLM */
  name: string;
  /** Human-readable description of what the tool does */
  description: string;
  /**
   * Dev-curated version string mirrored onto every report node this
   * tool produces. Free-form — semver, date, hash. Bump when the
   * tool's behavior changes in a way that matters for stored
   * trip-archive queries (schema rev, new API endpoint, semantic
   * change). The framework neither parses nor compares it.
   */
  version?: string;
  /**
   * Present-progressive UI string surfaced on `agent.tool.calling` /
   * `agent.tool.called` events for streaming UX (e.g.
   * `"Searching the catalog"`). Distinct from `description`, which
   * the LLM reads — `action` is for humans/UI.
   *
   * Two forms:
   * - **string** — static, used as-is.
   * - **function** — receives the model's **raw, pre-validation**
   *   input (resolved at the dispatch boundary, before `execute`'s
   *   schema validation runs) and returns a string, so callers can
   *   include input data
   *   (`(input) => \`Searching for "${input.query}"\``).
   *
   * Resolved at the framework boundary; consumers receive a
   * pre-resolved string in `ToolEventMeta.action`.
   */
  action?: string | ((input: TInput) => string);
  /** Optional metadata for documentation or tooling */
  meta?: ToolMeta;
  /**
   * Result-feedback mode. Defaults to `"feedback"` (standard
   * round-trip behavior) when unset. See {@link ToolMode} for the
   * full contract on `"silent"` semantics, constraints, and the
   * mixed-mode rule.
   */
  mode?: ToolMode;
  /**
   * Standard Schema-compatible input schema.
   * Any schema library implementing @standard-schema/spec works here
   * (e.g. Zod, Valibot, ArkType, warlock's seal).
   */
  input?: StandardSchemaV1<TInput>;
  /**
   * Execute the tool with validated input.
   * Called by the agent runtime after the LLM requests this tool.
   *
   * The optional second `ctx` parameter (Phase 5 / decisions §35)
   * carries a `ToolContext` with a mutable `artifacts` bag for
   * system-only side data. Tools written with the single-arg
   * signature continue to work unchanged — the framework supplies a
   * degraded ctx when one isn't threaded through.
   */
  execute(input: TInput, ctx?: ToolContext): Promise<TOutput>;
}
