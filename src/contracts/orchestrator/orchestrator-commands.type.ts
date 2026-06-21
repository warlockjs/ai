import type { Message } from "../conversation-message.type";

/**
 * Typed command surface for `orchestrator.command(name, args)` (design
 * §11). Each key is a command name; its value declares the command's
 * `args` and `result` shapes so the contract's `command<K>` method is
 * fully typed against the map.
 *
 * v1 ships exactly one built-in command, `compact`. v2 user commands
 * attach via module augmentation of this type — declaring additional
 * keys in a consumer's own `.d.ts` widens the map without a framework
 * release.
 *
 * @example
 * const result = await orchestrator.command("compact", {
 *   sessionId,
 *   history,
 * });
 * // result: { summary, replacesFromIndex, replacesToIndex }
 */
export type OrchestratorCommands = {
  /**
   * Force a manual compaction of the supplied session history outside
   * the automatic post-turn trigger. `result` is structurally
   * identical to `CompactionResult` (kept per the literal §11 shape).
   */
  compact: {
    args: { sessionId: string; history: Message[]; signal?: AbortSignal };
    result: {
      summary: Message;
      replacesFromIndex: number;
      replacesToIndex: number;
    };
  };
};
