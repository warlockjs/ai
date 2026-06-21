import type { BaseReport } from "../contracts/result/base-report.type";
import { REPORT_SCHEMA_VERSION } from "../contracts/result/base-report.type";

/**
 * Options for {@link stampReportLineage}. Every field is optional —
 * the caller supplies whichever pieces it knows. Missing pieces are
 * left untouched (existing values on the report survive).
 */
export type LineageStamp = {
  /**
   * The outermost run-id this subtree belongs to. When set, EVERY
   * node in the subtree gets its `rootRunId` rewritten to this
   * value — overrides any inner self-roots produced by nested
   * `buildResult` calls.
   */
  rootRunId: string;
  /**
   * Run-id of the immediate parent of THIS subtree's top node. Each
   * descendant's `parentRunId` is then derived from its own walk
   * position (its parent's `runId`).
   */
  parentRunId?: string;
  /**
   * Caller-supplied session identifier — propagates to every node in
   * the subtree. Skipped when undefined.
   */
  sessionId?: string;
};

/**
 * Walk a freshly-built report tree and stamp lineage fields onto
 * every node:
 *
 * - `rootRunId` — rewritten to `stamp.rootRunId` everywhere. Composite
 *   children built by inner primitives carry their own self-root; this
 *   walk overrides it so the outer root wins (single coherent run id
 *   across the whole tree).
 * - `parentRunId` — root node gets `stamp.parentRunId`; descendants
 *   derive theirs from each parent's own `runId`.
 * - `sessionId` — propagated when provided.
 * - `reportSchemaVersion` — stamped only on the root (the value is the
 *   same for the whole tree; storing it on every node would waste
 *   space).
 *
 * Designed to run ONCE per top-level `buildResult` call. Each
 * primitive's executor invokes this on the assembled root report just
 * before returning; nested primitives produced their own subtree with
 * a self-root, and this pass relinks everything to the outer caller's
 * lineage.
 *
 * Mutates the report in place — internal use only, before the report
 * is exposed via `result.report`.
 *
 * @example
 * const root = this.buildBareReport();
 * stampReportLineage(root, { rootRunId: this.runId, sessionId: this.options?.sessionId });
 * return { ..., report: root };
 */
export function stampReportLineage(root: BaseReport, stamp: LineageStamp): void {
  root.reportSchemaVersion = REPORT_SCHEMA_VERSION;

  walk(root, stamp.rootRunId, stamp.parentRunId, stamp.sessionId);
}

function walk(node: BaseReport, rootRunId: string, parentRunId?: string, sessionId?: string): void {
  node.rootRunId = rootRunId;

  if (parentRunId !== undefined) {
    node.parentRunId = parentRunId;
  } else {
    delete node.parentRunId;
  }

  if (sessionId !== undefined) {
    node.sessionId = sessionId;
  }

  for (const child of node.children) {
    walk(child, rootRunId, node.runId, sessionId);
  }
}
