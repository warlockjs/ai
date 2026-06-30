import type {
  InterruptStore,
  PendingInterrupt,
} from "../contracts/interrupt-store.contract";

/**
 * In-memory {@link InterruptStore} — pending interrupts held in a
 * process-local `Map`, never persisted to disk.
 *
 * Owns: the `interruptId → {@link PendingInterrupt}` index and the
 * last-writer-wins `save` / `load` / `delete` / `list` semantics the
 * contract declares. Does NOT own: durability, cross-process sharing, or
 * TTL eviction — it is the zero-config default for dev, tests, and
 * single-process apps whose approval flow stays interactive (the run
 * `await`s the decision in-process and never needs to survive a restart).
 * Reach for `ai.human.interrupt.pg()` / `ai.human.interrupt.redis()` when
 * a reviewer rules out-of-process, hours later.
 *
 * Front it with the {@link memory} factory — callers never `new` it.
 */
class MemoryInterruptStore implements InterruptStore {
  /** Pending interrupts keyed by their own `interruptId`. */
  private readonly interrupts = new Map<string, PendingInterrupt>();

  /**
   * Persist a pending interrupt, keyed by its own `interruptId`.
   * Overwrites any prior record for the same id — a call has exactly one
   * live interrupt, so a re-save replaces rather than appends.
   */
  public async save(record: PendingInterrupt): Promise<void> {
    this.interrupts.set(record.interruptId, record);
  }

  /**
   * Return the interrupt for an `interruptId`, or `undefined` when none is
   * recorded (never raised, or already resolved + deleted).
   */
  public async load(
    interruptId: string,
  ): Promise<PendingInterrupt | undefined> {
    return this.interrupts.get(interruptId);
  }

  /**
   * Drop the interrupt for an `interruptId`. Idempotent — deleting an
   * absent id is a no-op.
   */
  public async delete(interruptId: string): Promise<void> {
    this.interrupts.delete(interruptId);
  }

  /**
   * List the interrupt ids the store knows, optionally filtered by a
   * prefix. Returns a fresh array each call so a caller can mutate it
   * freely without touching the backing index.
   */
  public async list(prefix?: string): Promise<string[]> {
    const ids = [...this.interrupts.keys()];

    if (prefix === undefined) {
      return ids;
    }

    return ids.filter((id) => id.startsWith(prefix));
  }

  /**
   * The memory store has no backing table — there is nothing to migrate.
   * Returns an empty string so callers can treat `schema()` uniformly
   * across drivers.
   */
  public schema(): string {
    return "";
  }
}

/**
 * Create an in-memory {@link InterruptStore}. Zero-config — no client, no
 * connection. Suitable for dev, tests, and single-process apps whose
 * approval flow stays interactive and doesn't need resume across
 * restarts.
 *
 * @example
 * import { ai } from "@warlock.js/ai";
 *
 * const store = ai.human.interrupt.memory();
 *
 * const agent = ai.agent({
 *   model,
 *   tools: [deleteAccount],
 *   middleware: [
 *     ai.human.approval({
 *       policy: { type: "allowlist", tools: ["deleteAccount"] },
 *       store,
 *       handler,
 *     }),
 *   ],
 * });
 */
export function memory(): InterruptStore {
  return new MemoryInterruptStore();
}
