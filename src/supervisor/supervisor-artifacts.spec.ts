import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import { agent } from "../agent/agent";
import { END } from "../contracts/end.type";
import { SchemaValidationError } from "../errors";
import { MockSDK } from "../mock/mock-sdk";
import { tool } from "../tool/tool";
import { schema } from "./_test-helpers";
import { supervisor } from "./supervisor";

/**
 * Phase 5 / decisions §35 — `ctx.artifacts` side-channel.
 *
 * Verifies the iteration-end merge contract:
 *  - Tools mutate `ctx.artifacts`; values do NOT round-trip through
 *    the LLM-visible tool result.
 *  - Auto-spread default merges artifacts into state at iteration end.
 *  - `finalizeArtifacts` overrides for concat / cross-iteration cases.
 *  - The bag resets every iteration — long runs accumulate nothing.
 *  - `artifactsSchema` validates the bag at iteration end.
 *  - Standalone `tool.invoke()` (no supervisor) silently no-ops on
 *    artifact mutations — tools written for supervisor use stay
 *    callable elsewhere.
 */

const stringInputSchema: StandardSchemaV1<{ query: string }> = schema(value => {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as { query?: unknown }).query !== "string"
  ) {
    return { issues: [{ message: "query must be a string" }] };
  }

  return { value: value as { query: string } };
});

type Block = { type: "items"; itemIds: string[] };

function lastSnapshotState(result: { report: { snapshots: { state: Record<string, unknown> }[] } }): Record<string, unknown> {
  const snapshots = result.report.snapshots;

  return snapshots[snapshots.length - 1].state;
}

function makeSearchTool(opts: {
  blocks?: Block[];
  recordedCtxKeys?: () => unknown;
}) {
  return tool({
    name: "search_catalog",
    description: "Search items",
    input: stringInputSchema,
    execute: async (input, ctx) => {
      // Record what the tool sees in ctx for the standalone case.
      opts.recordedCtxKeys?.();

      const list = opts.blocks ?? [
        { type: "items", itemIds: ["a", "b"] } satisfies Block,
      ];

      // Side-channel write — the agent never sees this.
      const bag = ctx?.artifacts as { blocks?: Block[] } | undefined;
      if (bag) {
        bag.blocks ??= [];
        bag.blocks.push(...list);
      }

      // LLM-visible return — totals only, no IDs leaked into the prompt.
      return { total: list[0]?.itemIds.length ?? 0, query: input.query };
    },
  });
}

function buildScriptedAgentWithTool(params: {
  name: string;
  toolName: string;
  toolInput: unknown;
  toolContract: ReturnType<typeof tool>;
  iterations: number;
}) {
  // One iteration = one tool-call trip + one stop trip; multiply for
  // multi-iteration tests so each supervisor iteration can fire the
  // tool fresh.
  const responses = [];

  for (let i = 0; i < params.iterations; i++) {
    responses.push({
      content: "",
      finishReason: "tool_calls" as const,
      toolCalls: [
        {
          id: `call_${i}`,
          name: params.toolName,
          input: params.toolInput,
        },
      ],
    });

    responses.push({
      content: `done-${i}`,
      finishReason: "stop" as const,
    });
  }

  const sdk = MockSDK({ responses });
  const model = sdk.model({ name: `${params.name}-model` });

  return agent({
    name: params.name,
    description: "scripted agent that calls a tool",
    model,
    tools: [params.toolContract],
  });
}

describe("supervisor — tool ctx artifacts", () => {
  it("artifacts merge into state via auto-spread (single iteration)", async () => {
    const searchTool = makeSearchTool({});
    const searcher = buildScriptedAgentWithTool({
      name: "searcher",
      toolName: "search_catalog",
      toolInput: { query: "ac" },
      toolContract: searchTool,
      iterations: 1,
    });

    const supervisorInstance = supervisor({
      name: "artifacts-auto-spread",
      intents: { searcher },
      route: ctx => (ctx.iteration === 0 ? "searcher" : END),
    });

    const result = await supervisorInstance.execute("find AC");

    expect(result.error).toBeUndefined();
    expect((lastSnapshotState(result) as { blocks?: Block[] }).blocks).toEqual([
      { type: "items", itemIds: ["a", "b"] },
    ]);
  });

  it("finalizeArtifacts concatenates blocks across iterations", async () => {
    const searchTool = makeSearchTool({});
    const searcher = buildScriptedAgentWithTool({
      name: "searcher",
      toolName: "search_catalog",
      toolInput: { query: "ac" },
      toolContract: searchTool,
      iterations: 2,
    });

    let calls = 0;

    const supervisorInstance = supervisor<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, never>,
      { blocks?: Block[] }
    >({
      name: "artifacts-concat",
      intents: { searcher },
      route: ctx => {
        if (ctx.iteration < 2) {
          calls++;

          return "searcher";
        }

        return END;
      },
      finalizeArtifacts: (state, artifacts) => ({
        ...state,
        blocks: [
          ...(((state as { blocks?: Block[] }).blocks) ?? []),
          ...(artifacts.blocks ?? []),
        ],
      }),
    });

    const result = await supervisorInstance.execute("find");

    expect(result.error).toBeUndefined();
    expect(calls).toBe(2);
    expect((lastSnapshotState(result) as { blocks?: Block[] }).blocks).toEqual([
      { type: "items", itemIds: ["a", "b"] },
      { type: "items", itemIds: ["a", "b"] },
    ]);
  });

  it("artifacts bag resets between iterations (auto-spread + replace semantics)", async () => {
    const searchTool = makeSearchTool({});
    const searcher = buildScriptedAgentWithTool({
      name: "searcher",
      toolName: "search_catalog",
      toolInput: { query: "ac" },
      toolContract: searchTool,
      iterations: 2,
    });

    const supervisorInstance = supervisor({
      name: "artifacts-replace",
      intents: { searcher },
      route: ctx => (ctx.iteration < 2 ? "searcher" : END),
    });

    const result = await supervisorInstance.execute("find");

    // Auto-spread replace — iteration 1 overwrites iteration 0's
    // single block (no concat). The fact that we still see ONE block
    // (not zero, not two) proves the bag was populated in iteration 1
    // (so the reset between iterations worked) and replaced
    // iteration 0's value.
    expect((lastSnapshotState(result) as { blocks?: Block[] }).blocks).toEqual([
      { type: "items", itemIds: ["a", "b"] },
    ]);
  });

  it("artifactsSchema validates the bag at iteration end and aborts on failure", async () => {
    // Push a block whose shape violates the schema (missing `itemIds`).
    const searchTool = tool({
      name: "search_catalog",
      description: "search",
      input: stringInputSchema,
      execute: async (_input, ctx) => {
        const bag = ctx?.artifacts as { blocks?: unknown[] } | undefined;
        if (bag) {
          bag.blocks = [{ type: "items" }];
        }

        return { total: 0 };
      },
    });

    const searcher = buildScriptedAgentWithTool({
      name: "searcher",
      toolName: "search_catalog",
      toolInput: { query: "ac" },
      toolContract: searchTool,
      iterations: 1,
    });

    const blocksSchema = schema<{ blocks?: Block[] }>(value => {
      const blocks = (value as { blocks?: unknown[] }).blocks ?? [];

      for (const block of blocks) {
        if (
          !block ||
          typeof block !== "object" ||
          !Array.isArray((block as Block).itemIds)
        ) {
          return { issues: [{ message: "block.itemIds is required" }] };
        }
      }

      return { value: value as { blocks?: Block[] } };
    });

    const supervisorInstance = supervisor({
      name: "artifacts-schema-validation",
      intents: { searcher },
      route: ctx => (ctx.iteration === 0 ? "searcher" : END),
      artifactsSchema: blocksSchema,
    });

    const result = await supervisorInstance.execute("find");

    expect(result.error).toBeInstanceOf(SchemaValidationError);
    expect(result.error?.message).toMatch(/artifacts failed validation/);
  });

  it("snapshot.artifacts captures the raw bag pre-merge (Phase 8 / decisions §38)", async () => {
    const searchTool = makeSearchTool({});
    const searcher = buildScriptedAgentWithTool({
      name: "searcher",
      toolName: "search_catalog",
      toolInput: { query: "ac" },
      toolContract: searchTool,
      iterations: 2,
    });

    const supervisorInstance = supervisor<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, never>,
      { blocks?: Block[] }
    >({
      name: "artifacts-snapshot",
      intents: { searcher },
      route: ctx => (ctx.iteration < 2 ? "searcher" : END),
      // Use finalize that strips blocks entirely — proves snapshot
      // captures pre-merge data even when the merger discards it.
      finalizeArtifacts: state => state,
    });

    const result = await supervisorInstance.execute("find");

    expect(result.error).toBeUndefined();

    // Iterations 0 and 1 dispatched searcher and wrote a block;
    // snapshot.artifacts should carry those raw writes regardless of
    // finalizeArtifacts dropping them from state. Iteration 2 was the
    // terminal END-decision snapshot — no dispatch, no tool writes,
    // empty bag.
    const dispatchSnapshots = result.report.snapshots.filter(s => Object.keys(s.result).length > 0);
    expect(dispatchSnapshots.length).toBeGreaterThanOrEqual(2);

    for (const snapshot of dispatchSnapshots) {
      expect((snapshot.artifacts as { blocks?: Block[] }).blocks).toEqual([
        { type: "items", itemIds: ["a", "b"] },
      ]);
    }

    // State has no blocks (finalize dropped them) — proves snapshot
    // capture is independent of the merge transformation.
    expect((lastSnapshotState(result) as { blocks?: Block[] }).blocks).toBeUndefined();
  });

  it("snapshot.artifacts is empty {} for iterations whose tools wrote nothing", async () => {
    const noopAgent = buildScriptedAgentWithTool({
      name: "noop",
      toolName: "search_catalog",
      toolInput: { query: "x" },
      // Tool that returns but writes no artifacts:
      toolContract: tool({
        name: "search_catalog",
        description: "no-op tool",
        input: stringInputSchema,
        execute: async () => ({ ok: true }),
      }),
      iterations: 1,
    });

    const supervisorInstance = supervisor({
      name: "artifacts-empty-snapshot",
      intents: { noopAgent },
      route: ctx => (ctx.iteration === 0 ? "noopAgent" : END),
    });

    const result = await supervisorInstance.execute("hi");

    expect(result.error).toBeUndefined();
    expect(result.report.snapshots[0].artifacts).toEqual({});
  });

  it("standalone tool.invoke (no ctx supplied) treats artifact writes as no-ops", async () => {
    const searchTool = makeSearchTool({});

    const result = await searchTool.invoke({ query: "ac" });

    // Tool ran successfully, returned its visible value, and the
    // artifact mutation went into a degraded throwaway bag the
    // framework silently created.
    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ total: 2, query: "ac" });
  });

  it("tool's ctx.artifacts writes never appear in the LLM-visible tool result", async () => {
    const searchTool = tool({
      name: "search_catalog",
      description: "search",
      input: stringInputSchema,
      execute: async (input, ctx) => {
        const bag = ctx?.artifacts as { blocks?: Block[] } | undefined;

        if (bag) {
          bag.blocks ??= [];
          bag.blocks.push({ type: "items", itemIds: ["x", "y", "z"] });
        }

        return { total: 3, query: input.query };
      },
    });

    const sdk = MockSDK({
      responses: [
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            { id: "c0", name: "search_catalog", input: { query: "ac" } },
          ],
        },
        {
          content: "done",
          finishReason: "stop",
        },
      ],
    });

    const model = sdk.model({ name: "leak-check-model" });

    const searcher = agent({
      name: "searcher",
      model,
      tools: [searchTool],
    });

    const supervisorInstance = supervisor({
      name: "artifacts-leak-check",
      intents: { searcher },
      route: ctx => (ctx.iteration === 0 ? "searcher" : END),
    });

    const result = await supervisorInstance.execute("find AC");

    expect(result.error).toBeUndefined();

    // The model's second trip carries the tool result back as a
    // `tool` role message. Inspect that content to confirm the
    // artifact key never leaked into the LLM-visible channel.
    const lastCall = model.calls[model.calls.length - 1];
    const toolMessages = lastCall.messages.filter(
      message => message.role === "tool",
    );
    const toolResultBodies = toolMessages
      .map(message =>
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content),
      )
      .join("|");

    expect(toolResultBodies).not.toContain("blocks");
    expect(toolResultBodies).toContain('"total":3');

    expect((lastSnapshotState(result) as { blocks?: Block[] }).blocks).toEqual([
      { type: "items", itemIds: ["x", "y", "z"] },
    ]);
  });
});
