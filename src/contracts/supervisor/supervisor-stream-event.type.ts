import type { SupervisorEventMap } from "../events/event-map.type";

/**
 * Discriminated union of every event consumers see when iterating
 * `supervisor.stream()`. Mirrors `SupervisorEventMap` keys one-for-one
 * with payloads widened by adding the `type` discriminator, so
 * `for await` consumers can narrow via `event.type === "supervisor.xyz"`
 * the same way agent-stream consumers narrow on `"agent.xyz"`.
 */
export type SupervisorStreamEvent = {
  [K in keyof SupervisorEventMap]: { type: K } & SupervisorEventMap[K];
}[keyof SupervisorEventMap];
