import type { OrchestratorCommands } from "../contracts/orchestrator/orchestrator-commands.type";
import { SupervisorFailedError } from "../errors";

/**
 * Per-command handler bag — one async runner per key of
 * {@link OrchestratorCommands}. The orchestrator factory supplies the
 * `compact` runner (which delegates to the shared compaction code path,
 * §11) so this module owns command ROUTING only, never the compaction
 * logic itself.
 *
 * Typed against the same discriminated map the public `command<K>`
 * method uses, so a registered handler's `args` / result line up with
 * the contract with no casting at the call site.
 */
export type OrchestratorCommandHandlers = {
  [K in keyof OrchestratorCommands]: (
    args: OrchestratorCommands[K]["args"],
  ) => Promise<OrchestratorCommands[K]["result"]>;
};

/**
 * Build the typed `command(name, args)` dispatcher backing
 * {@link import("../contracts/orchestrator/orchestrator.contract").OrchestratorContract.command}
 * (design §11). Looks the command up in the supplied handler bag and
 * forwards `args`, preserving the discriminated `OrchestratorCommands`
 * typing end to end.
 *
 * v1 ships exactly one built-in command, `compact`. v2 user commands
 * attach via module augmentation of `OrchestratorCommands`; the
 * dispatcher widens with the map automatically, and an unregistered
 * command throws {@link SupervisorFailedError} rather than silently
 * resolving `undefined`.
 *
 * @example
 * const command = createCommandDispatcher({
 *   compact: (args) => runCompaction(args),
 * });
 * const result = await command("compact", { sessionId, history });
 */
export function createCommandDispatcher(handlers: OrchestratorCommandHandlers) {
  return function command<K extends keyof OrchestratorCommands>(
    name: K,
    args: OrchestratorCommands[K]["args"],
  ): Promise<OrchestratorCommands[K]["result"]> {
    const handler = handlers[name];

    if (typeof handler !== "function") {
      throw new SupervisorFailedError(
        `orchestrator.command(): unknown command "${String(name)}"`,
      );
    }

    return handler(args);
  };
}
