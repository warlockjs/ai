/**
 * Orchestrator engine barrel (orchestrator.md §20). Re-exports the
 * public `orchestrator()` factory plus the engine's public surface under
 * disambiguated names, mirroring the sibling supervisor barrel so both
 * engines flow through the root package barrel without colliding.
 *
 * The orchestrator's CONTRACT types (`OrchestratorContract`,
 * `OrchestratorConfig`, `OrchestratorResult`, events, command shapes,
 * the `CheckpointStore` / `SnapshotStore` contracts, …) live in
 * `src/contracts/orchestrator/` and `src/contracts/result/` and flow out
 * through `../contracts`; this barrel deliberately re-exports only the
 * runtime engine, never the contract types, to avoid duplicate
 * re-exports.
 */
export { asTool as orchestratorAsTool } from "./as-tool";
export {
  createCommandDispatcher as createOrchestratorCommandDispatcher,
  type OrchestratorCommandHandlers,
} from "./commands";
export { OrchestratorEmitter } from "./emitter";
export {
  injectMemories as injectOrchestratorMemories,
  memoryQueryFromInput as orchestratorMemoryQueryFromInput,
  outcomeTextFromTurn as orchestratorOutcomeTextFromTurn,
  recallForTurn as recallOrchestratorMemory,
  rememberTurnOutcome as rememberOrchestratorTurnOutcome,
  resolveOrchestratorMemory,
  type ResolvedOrchestratorMemory,
} from "./memory";
export {
  OrchestratorExecution,
  type OrchestratorExecutionParams,
  runTurn as runOrchestratorTurn,
  streamTurn as streamOrchestratorTurn,
  runResume as runOrchestratorResume,
} from "./execution";
export { orchestrator } from "./orchestrator";
export {
  createOrchestratorStream,
  type OrchestratorStreamController,
} from "./orchestrator-stream";
export { computeOrchestratorSignature } from "./signature";
