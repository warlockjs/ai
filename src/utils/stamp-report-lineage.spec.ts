import { describe, expect, it } from "vitest";
import type { BaseReport } from "../contracts/result/base-report.type";
import { REPORT_SCHEMA_VERSION } from "../contracts/result/base-report.type";
import { stampReportLineage } from "./stamp-report-lineage";

function leaf(runId: string, overrides: Partial<BaseReport> = {}): BaseReport {
  return {
    runId,
    rootRunId: runId,
    name: runId,
    type: "tool",
    status: "completed",
    startedAt: "2026-05-12T00:00:00.000Z",
    endedAt: "2026-05-12T00:00:00.100Z",
    duration: 100,
    usage: { input: 0, output: 0, total: 0 },
    children: [],
    ...overrides,
  };
}

describe("stampReportLineage", () => {
  it("stamps reportSchemaVersion on the root only", () => {
    const child = leaf("tool_1");
    const root = leaf("agent_1", { type: "agent", children: [child] });

    stampReportLineage(root, { rootRunId: root.runId });

    expect(root.reportSchemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(child.reportSchemaVersion).toBeUndefined();
  });

  it("rewrites rootRunId on every node to the outer root", () => {
    const composite = leaf("inner_workflow_1", {
      type: "workflow",
      rootRunId: "inner_workflow_1", // inner self-root from a nested buildResult
      children: [leaf("inner_step_tool", { rootRunId: "inner_workflow_1" })],
    });
    const root = leaf("outer_agent_1", { type: "agent", children: [composite] });

    stampReportLineage(root, { rootRunId: root.runId });

    expect(root.rootRunId).toBe("outer_agent_1");
    expect(composite.rootRunId).toBe("outer_agent_1");
    expect(composite.children[0].rootRunId).toBe("outer_agent_1");
  });

  it("derives parentRunId from walk position (each child's parent is its parent node's runId)", () => {
    const grandchild = leaf("tool_deep");
    const child = leaf("supervisor_mid", { type: "supervisor", children: [grandchild] });
    const root = leaf("agent_top", { type: "agent", children: [child] });

    stampReportLineage(root, { rootRunId: root.runId });

    expect(root.parentRunId).toBeUndefined();
    expect(child.parentRunId).toBe("agent_top");
    expect(grandchild.parentRunId).toBe("supervisor_mid");
  });

  it("clears parentRunId on the root when not supplied (purges stale inner values)", () => {
    const root = leaf("root_run", {
      parentRunId: "stale_inherited_from_inner_build_result",
    });

    stampReportLineage(root, { rootRunId: root.runId });

    expect(root.parentRunId).toBeUndefined();
  });

  it("sets parentRunId on the root when explicitly stamped", () => {
    const root = leaf("root_run");

    stampReportLineage(root, { rootRunId: root.runId, parentRunId: "outer" });

    expect(root.parentRunId).toBe("outer");
  });

  it("propagates sessionId to every node in the tree", () => {
    const grandchild = leaf("tool_deep");
    const child = leaf("supervisor_mid", { children: [grandchild] });
    const root = leaf("agent_top", { children: [child] });

    stampReportLineage(root, { rootRunId: root.runId, sessionId: "sess_user_42" });

    expect(root.sessionId).toBe("sess_user_42");
    expect(child.sessionId).toBe("sess_user_42");
    expect(grandchild.sessionId).toBe("sess_user_42");
  });

  it("leaves sessionId untouched when not supplied", () => {
    const root = leaf("root_run", { sessionId: "preexisting" });

    stampReportLineage(root, { rootRunId: root.runId });

    expect(root.sessionId).toBe("preexisting");
  });

  it("preserves nested structure — no reordering, no extra nodes", () => {
    const grandA = leaf("a");
    const grandB = leaf("b");
    const child = leaf("mid", { children: [grandA, grandB] });
    const root = leaf("top", { children: [child] });

    stampReportLineage(root, { rootRunId: root.runId });

    expect(root.children).toHaveLength(1);
    expect(root.children[0]).toBe(child);
    expect(child.children).toEqual([grandA, grandB]);
  });
});
