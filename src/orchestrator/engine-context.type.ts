import type { CheckpointStore } from "../contracts/orchestrator/checkpoint-store.contract";
import type { OrchestratorConfig } from "../contracts/orchestrator/orchestrator-config.type";
import type { SnapshotStore } from "../contracts/orchestrator/snapshot-store.contract";
import type { SupervisorIntentValue } from "../contracts/supervisor/intent-entry.type";
import type { OrchestratorEmitterLike } from "./emitter-port.type";
import type { ResolvedOrchestratorMemory } from "./memory";

/**
 * Everything the C2 engine needs to run a turn, assembled once by the
 * C1 factory at construction and passed into every engine entry point
 * (`runTurn` / `streamTurn` / `runResume` / `runCommand`).
 *
 * The factory owns construction, author-time validation, and signature
 * computation; the engine owns the 7-phase lifecycle (orchestrator.md
 * §3). Splitting the config from the resolved stores keeps the engine
 * agnostic to how the factory resolved its `checkpointStore` /
 * `snapshotStore` (own field vs `ai.config` default vs throw).
 *
 * `TState` flows through so the engine's state seed/patch merge is
 * typed against the orchestrator's session state shape.
 */
export type OrchestratorEngineContext<
  TOutput = unknown,
  TState = TOutput,
  TIntents extends Record<string, SupervisorIntentValue> = Record<
    string,
    SupervisorIntentValue
  >,
> = {
  /** The validated factory config (C1 has already run author-time checks). */
  config: OrchestratorConfig<TOutput, TState, TIntents>;
  /** Structural drift fingerprint computed by C1's `signature.ts`. */
  signature: string;
  /**
   * Resolved durable session store (own field → `ai.config`
   * default). C1 guarantees this is present — it throws
   * `OrchestratorConfigError` at construction when none resolves.
   */
  checkpointStore: CheckpointStore;
  /**
   * Resolved internal-supervisor snapshot store, or `undefined` when
   * `iterate: false`. C1 guarantees it is present whenever
   * `iterate: true`.
   */
  snapshotStore: SnapshotStore | undefined;
  /**
   * The orchestrator-scope event emitter (3-tier: definition →
   * instance → per-call). Owned by C1; the engine calls `emit` per
   * phase. Kept structurally minimal so the engine never depends on
   * C1's concrete emitter class.
   */
  emitter: OrchestratorEmitterLike;
  /**
   * Resolved per-turn memory wiring (memory core M2), or `undefined`
   * when the config declared no `memory`. Resolved once by the engine
   * at construction from the bare-store / config form so the lifecycle
   * reads one flat shape. When present, Phase 5 recalls + injects before
   * dispatch and remembers the outcome after a clean turn.
   */
  memory?: ResolvedOrchestratorMemory;
};
