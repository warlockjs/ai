// Storage contracts (orchestrator.md §8.2 / §8.4) — the durable
// foundation the orchestrator factory builds on. Public surface so devs
// can type their own stores and clients.
export type {
  CheckpointRecord,
  CheckpointStore,
} from "./checkpoint-store.contract";
export type {
  PgClientLike,
  RedisClientLike,
  SnapshotStore,
} from "./snapshot-store.contract";

// Orchestrator contract + factory surface (orchestrator.md §15). The
// per-turn result/report types (OrchestratorResult, OrchestratorReport,
// TurnSnapshot, CompactionResult) live under `contracts/result` and
// flow through that barrel.
export type {
  OrchestratorAsToolOptions,
  OrchestratorContract,
  OrchestratorSessionScope,
} from "./orchestrator.contract";
export type {
  OrchestratorConfig,
  OrchestratorMemoryConfig,
  SummarizeCallback,
  SummarizeConfig,
} from "./orchestrator-config.type";
export type { OrchestratorCommands } from "./orchestrator-commands.type";
export type {
  OrchestratorEvent,
  OrchestratorEventHandler,
  OrchestratorEventHandlers,
  OrchestratorEventMap,
  OrchestratorEventName,
} from "./orchestrator-event.type";
export type {
  OrchestratorExecuteOptions,
  OrchestratorResumeOptions,
} from "./orchestrator-execute-options.type";

// Obsolete session-object model — kept for one minor as @deprecated
// re-exports for non-breaking compatibility. The locked v1 design has
// no stateful session object; sessions are owned via a `sessionId`
// string passed per call. See the source files.
export type { SessionContextOverrides } from "./orchestrator.contract";
export type { SessionContract } from "./session.contract";
