import { describe, expect, it } from "vitest";
import type { AgentResult } from "../contracts/result/agent-result.type";
import type { WorkflowResult } from "../contracts/result/workflow-result.type";
import type { SupervisorIntentValue } from "../contracts/supervisor/intent-entry.type";
import type { WorkflowInstance } from "../contracts/workflow/workflow.contract";
import { buildScriptedAgent } from "./_test-helpers";
import {
  isAgentResult,
  isWorkflowResult,
  resolveIntentEntries,
} from "./entries";

/** A minimal workflow-shaped unit — `signature: string` is the discriminant. */
function fakeWorkflow(
  name: string,
  description = "a workflow",
): WorkflowInstance<unknown, unknown> {
  return {
    name,
    signature: "deadbeef",
    description,
    execute: async () => ({}) as never,
  } as unknown as WorkflowInstance<unknown, unknown>;
}

describe("resolveIntentEntries — happy resolution", () => {
  it("resolves a bare agent into an agent entry carrying the unit's description", () => {
    const agentUnit = buildScriptedAgent({
      name: "writer",
      description: "drafts content",
      responses: [{ content: "ok" }],
    });

    const map = resolveIntentEntries({ writer: agentUnit }, "sup");
    const entry = map.get("writer");

    expect(entry?.type).toBe("agent");
    expect(entry?.description).toBe("drafts content");
  });

  it("resolves a bare callback (function shorthand) into a description-less callback entry", () => {
    const map = resolveIntentEntries(
      { ping: (() => ({ pong: true })) as SupervisorIntentValue },
      "sup",
    );
    const entry = map.get("ping");

    expect(entry?.type).toBe("callback");
    // Bare shorthand has no description source — left undefined until a
    // router forces the upgrade (assertRouterDescriptions handles that).
    expect(entry?.type === "callback" && entry.description).toBeUndefined();
  });

  it("resolves an `{ agent, description }` entry, with the override winning over the unit description", () => {
    const agentUnit = buildScriptedAgent({
      name: "writer",
      description: "unit-level description",
      responses: [{ content: "ok" }],
    });

    const map = resolveIntentEntries(
      {
        writer: { agent: agentUnit, description: "override description" },
      },
      "sup",
    );

    expect(map.get("writer")?.description).toBe("override description");
  });

  it("resolves a workflow unit into a workflow entry", () => {
    const map = resolveIntentEntries(
      { research: fakeWorkflow("research") },
      "sup",
    );

    expect(map.get("research")?.type).toBe("workflow");
  });
});

describe("resolveIntentEntries — author-time validation", () => {
  it("throws when the intents map is empty", () => {
    expect(() => resolveIntentEntries({}, "sup")).toThrow(
      /must contain at least one entry/,
    );
  });

  it("throws when a value is neither agent, workflow, callback, nor entry object", () => {
    expect(() =>
      resolveIntentEntries(
        { bad: 42 as unknown as SupervisorIntentValue },
        "sup",
      ),
    ).toThrow(/is not an agent, workflow, callback, or entry object/);
  });

  it("throws SUPERVISOR_INTENT_MIXED_DISPATCH when an entry mixes agent + run", () => {
    const agentUnit = buildScriptedAgent({
      name: "writer",
      description: "drafts",
      responses: [{ content: "ok" }],
    });

    expect(() =>
      resolveIntentEntries(
        {
          confused: {
            agent: agentUnit,
            run: () => ({}),
          } as unknown as SupervisorIntentValue,
        },
        "sup",
      ),
    ).toThrow(/multiple dispatch fields/);
  });

  it("throws SUPERVISOR_INTENT_STREAM_ON_WORKFLOW when mode:stream sits on a workflow entry", () => {
    expect(() =>
      resolveIntentEntries(
        {
          research: {
            agent: fakeWorkflow("research"),
            mode: "stream",
            streamTo: "draft",
          } as unknown as SupervisorIntentValue,
        },
        "sup",
      ),
    ).toThrow(/stream mode is agent-only/);
  });

  it("throws when an object entry's `agent` resolves to a non-dispatchable value", () => {
    expect(() =>
      resolveIntentEntries(
        {
          broken: {
            agent: { notAnAgent: true },
          } as unknown as SupervisorIntentValue,
        },
        "sup",
      ),
    ).toThrow(/must be an AgentContract, WorkflowInstance, callback, or entry object/);
  });
});

describe("isAgentResult / isWorkflowResult", () => {
  it("isAgentResult narrows on the `type: \"agent\"` discriminant", () => {
    const agentRaw = { type: "agent" } as AgentResult<unknown>;
    const workflowRaw = { type: "workflow" } as WorkflowResult<unknown>;

    expect(isAgentResult(agentRaw)).toBe(true);
    expect(isAgentResult(workflowRaw)).toBe(false);
  });

  it("isWorkflowResult narrows on the `type: \"workflow\"` discriminant", () => {
    const agentRaw = { type: "agent" } as AgentResult<unknown>;
    const workflowRaw = { type: "workflow" } as WorkflowResult<unknown>;

    expect(isWorkflowResult(workflowRaw)).toBe(true);
    expect(isWorkflowResult(agentRaw)).toBe(false);
  });
});
