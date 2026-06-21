import type { Message } from "../contracts/conversation-message.type";
import type {
  SummarizeCallback,
  SummarizeConfig,
} from "../contracts/orchestrator/orchestrator-config.type";
import type { CompactionResult } from "../contracts/result/orchestrator-result.type";
import type { OrchestratorEngineContext } from "./engine-context.type";
import { DEFAULT_LOCK_MAX_WAIT } from "./lock";

/**
 * Most-recent messages kept verbatim when `summarize.keep` is omitted.
 * Defaulting to 0 would compact the entire history into one memo (losing
 * the live tail every turn), so the object form keeps a small recent
 * window by default — matching the canonical doc examples (`keep: 8`).
 */
export const DEFAULT_COMPACTION_KEEP = 8;

/** Whether the configured `summarize` is the fully-pluggable callback form. */
function isCallbackForm(
  summarize: SummarizeConfig | SummarizeCallback | undefined,
): summarize is SummarizeCallback {
  return typeof summarize === "function";
}

/**
 * Decide whether Phase 7 compaction should fire this turn (orchestrator
 * .md §4 Phase 7 / §12.1). v1 trigger is count-based:
 * `summarize.afterTurns` fires once `turnIndex >= afterTurns`. The
 * callback form has no threshold and never auto-fires — it is driven
 * exclusively by `command("compact")` (the manual path). Returns false
 * when `summarize` is unset.
 */
export function shouldCompact(
  ctx: OrchestratorEngineContext,
  turnIndex: number,
): boolean {
  const summarize = ctx.config.summarize;

  if (summarize === undefined || isCallbackForm(summarize)) {
    return false;
  }

  const afterTurns = summarize.afterTurns;

  return afterTurns !== undefined && turnIndex >= afterTurns;
}

/** Result of a Phase-7 run — what the engine folds into the turn. */
export type CompactionOutcome = {
  /** The produced compaction, surfaced on `result.compaction`. */
  compaction: CompactionResult;
  /**
   * Whether `summarize.onCompact` ran AND succeeded — when true the
   * engine advances `summarized_through` to `replacesToIndex` (§12.2
   * step 4); when false it leaves it unchanged (§12.2 step 5).
   */
  applied: boolean;
};

/**
 * Run the configured summarizer against the session history and build
 * a {@link CompactionResult} (§12.2 step 2–3). Three resolution paths:
 *
 * - callback form — `summarize(history)` returns the result directly.
 * - config + `summarizer` model — summarize the slice (history minus
 *   the most-recent `keep`) into one synthetic memo turn.
 * - config without a `summarizer` — produce a trivial degenerate memo
 *   (no model available); the dev is expected to supply a summarizer
 *   for real compaction. The range still reflects the kept tail.
 */
async function produceCompaction(
  summarize: SummarizeConfig | SummarizeCallback,
  history: Message[],
): Promise<CompactionResult> {
  if (isCallbackForm(summarize)) {
    return summarize(history);
  }

  const keep = summarize.keep ?? DEFAULT_COMPACTION_KEEP;
  const replacesFromIndex = 0;
  const replacesToIndex = Math.max(-1, history.length - keep - 1);
  const slice = history.slice(0, replacesToIndex + 1);

  const summaryText = await summarizeSlice(summarize, slice);

  return {
    summary: { role: "system", content: summaryText },
    replacesFromIndex,
    replacesToIndex,
  };
}

/**
 * Summarize a slice of history into text. Uses the configured
 * `summarizer` model when present (a single non-streaming completion);
 * otherwise returns a placeholder memo. The summarizer is intentionally
 * the cheap model — never the specialists (§12.4).
 */
async function summarizeSlice(
  summarize: SummarizeConfig,
  slice: Message[],
): Promise<string> {
  if (slice.length === 0) {
    return "";
  }

  if (!summarize.summarizer) {
    return `Summary of ${slice.length} prior message(s).`;
  }

  const transcript = slice
    .map((message) => `${message.role}: ${stringifyContent(message.content)}`)
    .join("\n");

  const response = await summarize.summarizer.complete([
    {
      role: "system",
      content:
        "Summarize the following conversation slice into a concise memo " +
        "that preserves the facts, decisions, and open threads a later " +
        "turn would need. Reply with the memo only.",
    },
    { role: "user", content: transcript },
  ]);

  return response.content;
}

/** Coerce a message's content into a flat string for the summarizer prompt. */
function stringifyContent(content: Message["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return JSON.stringify(content);
}

/**
 * Phase 7 — post-turn compaction (orchestrator.md §3 / §4 Phase 7 /
 * §12.2). Runs AFTER the turn settles; never blocks the caller's
 * resolution path beyond this phase.
 *
 * Acquires the cooperative session lock (writes `lock_acquired_at` /
 * `lock_expires_at` onto a fresh row), runs the summarizer, builds the
 * compaction, then either invokes `summarize.onCompact` (framework-
 * driven apply) or surfaces the compaction on the result for the dev to
 * apply. Releases the lock on settle. Emits
 * `orchestrator.compaction.suggested` always,
 * `orchestrator.compaction.applied` only when `onCompact` succeeded, and
 * `orchestrator.compaction.failed` (carrying the thrown `error` and the
 * `phase` that failed) when the summarizer or `onCompact` throws.
 *
 * Retry policy is skip-and-log (§4 Phase 7): a summarizer failure
 * leaves the session running with unchanged history — the engine
 * treats a thrown summarizer / `onCompact` as "no compaction this
 * turn", emits `orchestrator.compaction.failed`, and returns `undefined`
 * (summarizer) or surfaces the unapplied compaction (`onCompact`).
 */
export async function runCompaction<TState>(
  ctx: OrchestratorEngineContext<unknown, TState>,
  sessionId: string,
  history: Message[],
): Promise<CompactionOutcome | undefined> {
  const summarize = ctx.config.summarize;

  if (summarize === undefined) {
    return undefined;
  }

  await acquireCompactionLock(ctx, sessionId);

  try {
    const compaction = await produceCompaction(summarize, history);

    ctx.emitter.emit("orchestrator.compaction.suggested", {
      sessionId,
      compaction,
    });

    const onCompact = isCallbackForm(summarize) ? undefined : summarize.onCompact;

    if (!onCompact) {
      return { compaction, applied: false };
    }

    try {
      await onCompact(compaction, { sessionId });

      ctx.emitter.emit("orchestrator.compaction.applied", {
        sessionId,
        compaction,
      });

      return { compaction, applied: true };
    } catch (error) {
      // onCompact threw — surface the compaction for the dev to apply,
      // leave summarized_through unchanged (§12.2 step 4 failure path).
      ctx.emitter.emit("orchestrator.compaction.failed", {
        sessionId,
        phase: "onCompact",
        error,
      });

      return { compaction, applied: false };
    }
  } catch (error) {
    // Summarizer failed — skip-and-log; session keeps running unchanged.
    ctx.emitter.emit("orchestrator.compaction.failed", {
      sessionId,
      phase: "summarize",
      error,
    });

    return undefined;
  } finally {
    await releaseCompactionLock(ctx, sessionId);
  }
}

/**
 * Run a manual compaction for `command("compact", ...)` (§11 / §12.1).
 * Same code path as the post-turn trigger but driven on demand against
 * the supplied history, returning the raw {@link CompactionResult}. The
 * callback form is honored; the config form without a `summarizer`
 * produces the degenerate memo. Does not apply `onCompact` — the
 * command surface returns the compaction for the caller to handle.
 */
export async function runManualCompaction<TState>(
  ctx: OrchestratorEngineContext<unknown, TState>,
  history: Message[],
): Promise<CompactionResult> {
  const summarize = ctx.config.summarize;

  if (summarize === undefined) {
    // No summarize policy configured — produce a degenerate memo over
    // the full supplied history so the command always resolves.
    return {
      summary: { role: "system", content: `Summary of ${history.length} message(s).` },
      replacesFromIndex: 0,
      replacesToIndex: Math.max(-1, history.length - 1),
    };
  }

  return produceCompaction(summarize, history);
}

/** Resolve the lock TTL from the summarize config (config form only). */
function resolveLockMaxWait(ctx: OrchestratorEngineContext): number {
  const summarize = ctx.config.summarize;

  if (summarize === undefined || isCallbackForm(summarize)) {
    return DEFAULT_LOCK_MAX_WAIT;
  }

  return summarize.lock?.maxWait ?? DEFAULT_LOCK_MAX_WAIT;
}

/**
 * Write the cooperative compaction lock onto a fresh checkpoint row
 * (§12.2 step 1). The lock lives on the latest persisted row; we load
 * it, stamp the lock columns, and re-save (append-only) so the next
 * turn's Phase 3 observes it.
 */
async function acquireCompactionLock<TState>(
  ctx: OrchestratorEngineContext<unknown, TState>,
  sessionId: string,
): Promise<void> {
  const latest = await ctx.checkpointStore.load(ctx.config.name, sessionId);

  if (!latest) {
    return;
  }

  const now = Date.now();
  const maxWait = resolveLockMaxWait(ctx as OrchestratorEngineContext);

  await ctx.checkpointStore.save({
    ...latest,
    lock_acquired_at: new Date(now).toISOString(),
    lock_expires_at: new Date(now + maxWait).toISOString(),
    saved_at: new Date(now).toISOString(),
  });
}

/**
 * Clear the compaction lock columns (§12.2 step 6) by re-saving the
 * latest row with the lock fields nulled.
 */
async function releaseCompactionLock<TState>(
  ctx: OrchestratorEngineContext<unknown, TState>,
  sessionId: string,
): Promise<void> {
  const latest = await ctx.checkpointStore.load(ctx.config.name, sessionId);

  if (!latest) {
    return;
  }

  await ctx.checkpointStore.save({
    ...latest,
    lock_acquired_at: null,
    lock_expires_at: null,
    saved_at: new Date().toISOString(),
  });
}
