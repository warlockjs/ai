import type { OrchestratorConfig } from "../contracts/orchestrator/orchestrator-config.type";
import type {
  OrchestratorEventHandler,
  OrchestratorEventName,
} from "../contracts/orchestrator/orchestrator-event.type";
import type {
  OrchestratorAsToolOptions,
  OrchestratorContract,
} from "../contracts/orchestrator/orchestrator.contract";
import type { OrchestratorCommands } from "../contracts/orchestrator/orchestrator-commands.type";
import type {
  OrchestratorExecuteOptions,
  OrchestratorResumeOptions,
} from "../contracts/orchestrator/orchestrator-execute-options.type";
import type { OrchestratorEvent } from "../contracts/orchestrator/orchestrator-event.type";
import type { OrchestratorResult } from "../contracts/result/orchestrator-result.type";
import type { StreamContract } from "../contracts/stream/stream.contract";
import type { SupervisorIntentValue } from "../contracts/supervisor/intent-entry.type";
import type { SupervisorInput } from "../contracts/supervisor/supervisor-input.type";
import { resolveDefaultSnapshotStore } from "../config";
import { OrchestratorConfigError } from "../errors/orchestrator-config-error";
import { resolveIntentEntries, type ResolvedIntentEntry } from "../supervisor/entries";
import { SupervisorFailedError } from "../errors";
import type { ToolContract } from "../tool/tool";
import type { SessionLock } from "../contracts/orchestrator/session-lock.contract";
import { asTool as orchestratorAsTool } from "./as-tool";
import { createCommandDispatcher } from "./commands";
import { OrchestratorEmitter } from "./emitter";
import { OrchestratorExecution } from "./execution";
import { createOrchestratorStream } from "./orchestrator-stream";
import { inProcessSessionLock, noopSessionLock } from "./session-lock";
import { computeOrchestratorSignature } from "./signature";

/**
 * `ai.orchestrator(config)` — construct an {@link OrchestratorContract}:
 * a session-state manager wrapped around a supervisor (orchestrator.md
 * §1, §15). Validates the config at author time (throws
 * {@link OrchestratorConfigError} on bad shape), resolves the intent
 * entries, computes a stable structural signature for drift detection
 * (§10.1), wires the three-tier event emitter, and returns a handle that
 * runs one durable session turn per `execute` / `stream` call, resumes
 * an interrupted `iterate: true` turn via `resume`, and exposes typed
 * built-in commands plus an `asTool` wrapper.
 *
 * The "what runs" fields (`intents`, `route` / `router`, `evaluate`,
 * `state`, `output`, `initialAgent`, `maxIterations`) are the
 * supervisor's surface spread directly — the lifecycle builds the
 * supervisor lazily per turn and delegates to it (§3 Phase 5). Users
 * never see the supervisor object.
 *
 * @example
 * const supportBot = ai.orchestrator<SessionState>({
 *   name: "refund-support",
 *   intents: { classify, lookup, process, compose },
 *   route: (ctx) => (ctx.iteration === 0 ? "classify" : END),
 *   iterate: true,
 *   checkpointStore: ai.checkpoint.pg({ client: pg }),
 *   snapshotStore: ai.snapshot.pg({ client: pg }),
 * });
 *
 * const result = await supportBot.execute(message, { sessionId, history });
 */
export function orchestrator<
  TOutput = unknown,
  TState = TOutput,
  TIntents extends Record<string, SupervisorIntentValue> = Record<
    string,
    SupervisorIntentValue
  >,
>(
  config: OrchestratorConfig<TOutput, TState, TIntents>,
): OrchestratorContract<TOutput, TState> {
  validateFactoryConfig(config as unknown as OrchestratorConfig<unknown>);

  const entries = resolveEntries(config as unknown as OrchestratorConfig<unknown>);

  assertInitialAgent(config as unknown as OrchestratorConfig<unknown>, entries);

  const signature = computeOrchestratorSignature(
    config as unknown as OrchestratorConfig<unknown>,
    entries,
  );
  const emitter = new OrchestratorEmitter(config.on);

  // Per-session turn serialization (C4). Resolved ONCE so every turn on
  // this orchestrator shares the same lock — that's what lets the
  // in-process default actually serialize concurrent same-session calls.
  const sessionLock = resolveSessionLock(config as unknown as OrchestratorConfig<unknown>);
  warnOnUnlockedDurableStore(config as unknown as OrchestratorConfig<unknown>);

  async function execute(
    input: SupervisorInput,
    options: OrchestratorExecuteOptions<TState>,
  ): Promise<OrchestratorResult<TOutput>> {
    const execution = new OrchestratorExecution<TOutput, TState>({
      config: config as unknown as OrchestratorConfig<TOutput, TState>,
      entries,
      signature,
      emitter,
      input,
      options,
    });

    // Serialize the whole turn (load → dispatch → persist) against any
    // concurrent turn for the same session, so the checkpoint's
    // read-modify-write can't lose an update.
    return sessionLock.withLock(options.sessionId, () => execution.run(), {
      signal: options.signal,
    });
  }

  function stream(
    input: SupervisorInput,
    options: OrchestratorExecuteOptions<TState>,
  ): StreamContract<OrchestratorResult<TOutput>, OrchestratorEvent> {
    const { controller, stream: contract } = createOrchestratorStream<
      OrchestratorResult<TOutput>
    >();

    const execution = new OrchestratorExecution<TOutput, TState>({
      config: config as unknown as OrchestratorConfig<TOutput, TState>,
      entries,
      signature,
      emitter,
      input,
      options,
      streamController: controller,
    });

    // The background run waits for the session lock before it starts —
    // same serialization guarantee as `execute`; the stream contract is
    // still returned synchronously.
    void sessionLock.withLock(options.sessionId, () => execution.run(), {
      signal: options.signal,
    });

    return contract;
  }

  async function resume(
    sessionId: string,
    options?: OrchestratorResumeOptions,
  ): Promise<OrchestratorResult<TOutput> | null> {
    const execution = new OrchestratorExecution<TOutput, TState>({
      config: config as unknown as OrchestratorConfig<TOutput, TState>,
      entries,
      signature,
      emitter,
      resumeSessionId: sessionId,
      resumeOptions: options,
    });

    return sessionLock.withLock(sessionId, () => execution.resume(), {
      signal: options?.signal,
    });
  }

  // The dispatcher owns command ROUTING only; the `compact` handler
  // delegates to the shared compaction code path on the lifecycle engine
  // (§11 / §12.2 — manual compact reuses the post-turn compaction path).
  const command = createCommandDispatcher({
    compact: (args: OrchestratorCommands["compact"]["args"]) => {
      const execution = new OrchestratorExecution<TOutput, TState>({
        config: config as unknown as OrchestratorConfig<TOutput, TState>,
        entries,
        signature,
        emitter,
      });

      return execution.compact(args);
    },
  });

  const instance: OrchestratorContract<TOutput, TState> = {
    name: config.name,
    signature,
    version: config.version,
    execute,
    stream,
    resume,
    command,
    asTool<TToolInput = string>(
      options: OrchestratorAsToolOptions<TToolInput>,
    ): ToolContract<TToolInput, TOutput> {
      return orchestratorAsTool<TOutput, TState, TToolInput>(instance, options);
    },
    on<K extends OrchestratorEventName>(
      event: K,
      handler: OrchestratorEventHandler<K>,
    ): () => void {
      return emitter.on(event, handler);
    },
    off<K extends OrchestratorEventName>(
      event: K,
      handler: OrchestratorEventHandler<K>,
    ): void {
      emitter.off(event, handler);
    },
  };

  return instance;
}

/**
 * Author-time validation (orchestrator.md §17). Enforces the rules that
 * must fail at construction rather than on the first turn:
 *
 * - `name` present and a string.
 * - `intents` present.
 * - `route` XOR `router` (mutually exclusive; at least one required) —
 *   the supervisor's dispatch-source rule, surfaced as an orchestrator
 *   config error.
 * - `router` is a valid agent contract or `{ agent, ... }` entry.
 * - `maxIterations >= 1` when set.
 * - `snapshotStore` resolvable when `iterate: true` — explicit field or
 *   the global `ai.config({ defaultSnapshotStore })` fallback.
 *
 * `initialAgent` membership is checked separately once the intent
 * entries are resolved.
 */
function validateFactoryConfig(config: OrchestratorConfig<unknown>): void {
  if (!config.name || typeof config.name !== "string") {
    throw new OrchestratorConfigError(
      "ai.orchestrator: `name` is required and must be a string",
      { context: { authoring: true } },
    );
  }

  if (!config.intents || typeof config.intents !== "object") {
    throw new OrchestratorConfigError(
      `ai.orchestrator("${config.name}"): \`intents\` is required`,
      { context: { authoring: true } },
    );
  }

  const hasRoute = typeof config.route === "function";
  const hasRouter = Boolean(config.router);

  if (hasRouter) {
    const router = config.router;
    const isBareAgent = typeof (router as { execute?: unknown }).execute === "function";
    const isEntryForm =
      !isBareAgent &&
      typeof (router as { agent?: { execute?: unknown } }).agent === "object" &&
      typeof (router as { agent?: { execute?: unknown } }).agent?.execute === "function";

    if (!isBareAgent && !isEntryForm) {
      throw new OrchestratorConfigError(
        `ai.orchestrator("${config.name}"): \`router\` must be an agent contract or a \`{ agent, placeholders?, input? }\` entry`,
        { context: { authoring: true } },
      );
    }
  }

  if (hasRoute && hasRouter) {
    throw new OrchestratorConfigError(
      `ai.orchestrator("${config.name}"): \`route\` and \`router\` are mutually exclusive — configure exactly one`,
      { context: { authoring: true } },
    );
  }

  if (!hasRoute && !hasRouter) {
    throw new OrchestratorConfigError(
      `ai.orchestrator("${config.name}"): one of \`route\` or \`router\` is required`,
      { context: { authoring: true } },
    );
  }

  if (config.maxIterations !== undefined && config.maxIterations < 1) {
    throw new OrchestratorConfigError(
      `ai.orchestrator("${config.name}"): \`maxIterations\` must be >= 1`,
      { context: { authoring: true, maxIterations: config.maxIterations } },
    );
  }

  if (config.iterate && !config.snapshotStore && !resolveDefaultSnapshotStore()) {
    throw new OrchestratorConfigError(
      `ai.orchestrator("${config.name}"): \`iterate: true\` requires a \`snapshotStore\` (or \`ai.config({ defaultSnapshotStore })\`) for mid-turn resume`,
      { context: { authoring: true } },
    );
  }
}

/**
 * Resolve the `intents` map into the supervisor's internal entry shape,
 * re-wrapping the supervisor's authoring failure as an
 * {@link OrchestratorConfigError} so misuse surfaces under the
 * orchestrator's error family rather than the supervisor's.
 */
function resolveEntries(
  config: OrchestratorConfig<unknown>,
): Map<string, ResolvedIntentEntry> {
  try {
    return resolveIntentEntries(config.intents, config.name);
  } catch (error) {
    if (error instanceof SupervisorFailedError) {
      throw new OrchestratorConfigError(error.message, {
        context: { authoring: true },
        cause: error,
      });
    }

    throw error;
  }
}

/**
 * Enforce the `initialAgent` membership rule (§17) once entries are
 * resolved — `initialAgent`, when set, must name a key in `intents`.
 */
function assertInitialAgent(
  config: OrchestratorConfig<unknown>,
  entries: Map<string, ResolvedIntentEntry>,
): void {
  if (config.initialAgent && !entries.has(config.initialAgent)) {
    throw new OrchestratorConfigError(
      `ai.orchestrator("${config.name}"): \`initialAgent\` "${config.initialAgent}" is not a key in \`intents\``,
      { context: { authoring: true } },
    );
  }
}

/**
 * Resolve the per-session lock (C4): an explicit {@link SessionLock} when
 * supplied, a no-op when `sessionLock: false`, otherwise the framework
 * default in-process mutex.
 */
function resolveSessionLock(config: OrchestratorConfig<unknown>): SessionLock {
  if (config.sessionLock === false) return noopSessionLock();
  if (config.sessionLock) return config.sessionLock;
  return inProcessSessionLock();
}

/** Orchestrator names already warned about an unlocked durable store. */
const warnedUnlockedStores = new Set<string>();

/**
 * Warn once when a durable `checkpointStore` is configured but no explicit
 * `sessionLock` was supplied (C4). The in-process default serializes
 * same-session turns within one process only — a horizontally-scaled
 * deployment needs a distributed lock or sticky routing. Suppressed in
 * tests and when the dev explicitly chose a lock (or `sessionLock: false`).
 */
function warnOnUnlockedDurableStore(config: OrchestratorConfig<unknown>): void {
  if (config.sessionLock !== undefined) return;
  if (!config.checkpointStore) return;
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
  if (warnedUnlockedStores.has(config.name)) return;
  warnedUnlockedStores.add(config.name);

  console.warn(
    `[warlock-ai] orchestrator "${config.name}" uses a durable checkpointStore with the default in-process sessionLock. ` +
      "That serializes same-session turns within ONE process only; in a horizontally-scaled deployment supply a distributed " +
      "`sessionLock` (Redis/Postgres advisory locks) or use sticky routing. Pass `sessionLock: false` to silence this.",
  );
}
