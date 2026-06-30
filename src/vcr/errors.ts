import { AIError } from "../errors/ai-error";
import type { AIErrorOptions } from "../errors/ai-error";

/**
 * Payload for {@link VcrCassetteMissError}. Carries the looked-up request
 * hash and the cassette path so a failing CI run names exactly which call
 * was not recorded.
 */
export type VcrCassetteMissErrorOptions = AIErrorOptions & {
  /** The normalized request hash that found no matching cassette entry. */
  requestHash?: string;
  /** Cassette file path the lookup ran against. */
  path?: string;
};

/**
 * Thrown when a `vcr(model, { mode: "replay" })` call finds no cassette
 * entry matching the request hash.
 *
 * **The whole point of deterministic tests.** VCR in `replay` mode never
 * falls back to a live provider call on a miss — that would silently
 * re-introduce network/non-determinism into a test that asked for the
 * opposite. Instead it throws this error so the run fails loud, telling
 * the developer to re-record the cassette (run once in `record`/`auto`).
 *
 * Extends {@link AIError} directly (not `ProviderError`) — a cassette miss
 * is a harness/config failure, not a provider failure.
 *
 * @example
 * try {
 *   await vcrModel.complete(messages);
 * } catch (error) {
 *   if (error instanceof VcrCassetteMissError) {
 *     console.error("Re-record the cassette:", error.path);
 *   }
 * }
 */
export class VcrCassetteMissError extends AIError {
  public readonly requestHash?: string;
  public readonly path?: string;

  public constructor(message: string, options?: VcrCassetteMissErrorOptions) {
    super("VCR_CASSETTE_MISS", message, options);
    this.name = "VcrCassetteMissError";
    this.requestHash = options?.requestHash;
    this.path = options?.path;
  }
}
