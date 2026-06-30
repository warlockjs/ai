import { AsyncLocalStorage } from "node:async_hooks";
import type { BaseReport } from "../contracts/result/base-report.type";

/**
 * The ambient run frame an executable reads when it finishes building
 * its report. When present, a child execution (an `agent.execute()`,
 * `workflow.execute()`, `supervisor.execute()` call) auto-attaches its
 * report to `sink` and inherits the frame's `rootRunId` / `sessionId`
 * lineage — so reports nest under the enclosing run with NO manual id
 * threading by the dev.
 *
 * Installed by orchestration primitives (supervisor / orchestrator /
 * team) around the synchronous + async body of an intent's callback,
 * so any agent the callback invokes directly — `agent.execute(...)`
 * rather than `ctx.run(...)` — still lands in the trace tree.
 */
export type RunFrame = {
  /**
   * The `children[]` array of the enclosing report node. A child
   * execution pushes its assembled report here on completion.
   */
  sink: BaseReport[];
  /**
   * The outermost run-id this subtree belongs to. Propagated onto the
   * child report's `rootRunId` so flat-row consumers group it with the
   * enclosing run.
   */
  rootRunId: string;
  /**
   * Run-id of the enclosing node (the immediate parent of any child
   * captured through this frame). Stamped onto the child's
   * `parentRunId`.
   */
  parentRunId: string;
  /**
   * Session identifier propagated onto the captured child's subtree.
   * `undefined` when the enclosing run had none.
   */
  sessionId?: string;
};

/**
 * Process-wide async-local store holding the current {@link RunFrame}.
 * A single shared instance so a frame installed by the supervisor is
 * visible to an agent running several `await`s deep inside a callback,
 * across module boundaries. Empty (returns `undefined`) outside any
 * orchestration callback — standalone `agent.execute()` is unaffected.
 */
const runFrameStore = new AsyncLocalStorage<RunFrame | undefined>();

/**
 * A second async-local flag set whenever execution is nested inside a
 * parent capture — by BOTH {@link withRunFrame} (ambient capture) and
 * {@link withoutRunFrame} (explicit parent capture, which clears the frame).
 * Lets the `observeAll` gate skip self-routing a nested run regardless of
 * which capture path its parent uses — the parent already captures it.
 */
const nestedStore = new AsyncLocalStorage<boolean>();

/**
 * Run `fn` with `frame` installed as the ambient {@link RunFrame} for
 * the entire async subtree it spawns. Restores the previous frame (or
 * none) when `fn` settles. Returns whatever `fn` returns.
 *
 * Nesting is natural: a callback that itself dispatches a nested
 * supervisor installs a fresh frame for the inner run, and the inner
 * frame shadows the outer one for the inner subtree only — exactly the
 * tree shape the report models.
 */
export function withRunFrame<T>(frame: RunFrame, fn: () => T): T {
  return nestedStore.run(true, () => runFrameStore.run(frame, fn));
}

/**
 * Run `fn` with NO ambient {@link RunFrame} installed for its async
 * subtree, restoring the previous frame when `fn` settles. Used by the
 * supervisor's EXPLICIT capture paths (`ctx.run(...)` /
 * `ctx.intents.X.execute()`) — those already push the child report onto
 * the callback's `children[]` themselves, so the child must NOT also
 * self-capture via the ambient frame (which would double-count it).
 */
export function withoutRunFrame<T>(fn: () => T): T {
  return nestedStore.run(true, () => runFrameStore.run(undefined, fn));
}

/**
 * Read the current ambient {@link RunFrame}, or `undefined` when no
 * orchestration callback is on the stack. An executable calls this at
 * report-build time: a present frame means "you were invoked inside a
 * callback — attach yourself to its tree".
 */
export function currentRunFrame(): RunFrame | undefined {
  return runFrameStore.getStore();
}

/**
 * `true` when execution is nested inside a parent capture — set by
 * {@link withRunFrame} (ambient) or {@link withoutRunFrame} (explicit). Read
 * by the observe-all gate so a nested run, which its parent already captures
 * into the trace tree, is not also self-routed as a standalone top-level
 * trace. `false` for a standalone (root) run.
 */
export function isNestedRun(): boolean {
  return nestedStore.getStore() === true;
}

/**
 * Capture a freshly-built child `report` onto the current ambient
 * {@link RunFrame} when one is installed. Pushes the report onto the
 * frame's `sink` so it nests under the enclosing node, and rewrites the
 * report's lineage (`rootRunId`, `parentRunId`, `sessionId`) to the
 * frame's — mirroring how `step.agent` / `ctx.run` capture child
 * reports explicitly, but driven ambiently.
 *
 * No-op (returns `false`) when no frame is installed — a standalone
 * `agent.execute()` keeps its self-root untouched. Returns `true` when
 * the report was captured so the caller can suppress its own terminal
 * lineage stamp if needed.
 *
 * The lineage rewrite is intentionally shallow on the root + deep on
 * descendants would double-stamp; callers pass the already-lineage-
 * stamped subtree (self-root), and this relinks only the root's
 * `rootRunId` / `parentRunId` / `sessionId`. Descendants already carry
 * the child's own self-root as their `rootRunId`; the enclosing
 * primitive's terminal `stampReportLineage` pass (run once on the
 * outer tree) rewrites the whole subtree to the true outer root. This
 * keeps capture cheap and defers the single authoritative relink to
 * the outer build.
 */
export function captureChildReport(report: BaseReport): boolean {
  const frame = runFrameStore.getStore();

  if (!frame) {
    return false;
  }

  report.parentRunId = frame.parentRunId;
  report.rootRunId = frame.rootRunId;

  if (frame.sessionId !== undefined) {
    report.sessionId = frame.sessionId;
  }

  frame.sink.push(report);

  return true;
}
