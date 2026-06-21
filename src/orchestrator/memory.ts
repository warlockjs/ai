import type { MemoryContract } from "../contracts/memory/memory.contract";
import type {
  MemoryItem,
  RecalledMemory,
} from "../contracts/memory/memory-item.type";
import type { OrchestratorMemoryConfig } from "../contracts/orchestrator/orchestrator-config.type";
import type { TurnSnapshot } from "../contracts/result/orchestrator-result.type";
import type { SupervisorInput } from "../contracts/supervisor/supervisor-input.type";

/** Default key the recalled memories are injected under in the context bag. */
const DEFAULT_INJECT_KEY = "memories";

/**
 * Memory wiring resolved once per turn from `OrchestratorConfig.memory`
 * (memory core M2). Normalizes the two accepted config shapes — a bare
 * {@link MemoryContract} or the richer {@link OrchestratorMemoryConfig} —
 * into a single flat record the lifecycle phase reads, so `runTurn` never
 * branches on which form the dev supplied.
 */
export type ResolvedOrchestratorMemory = {
  /** The store recalled-from before dispatch and remembered-into after. */
  store: MemoryContract;
  /** Recall count cap; `0` disables recall (write-only memory). */
  k?: number;
  /** Semantic-similarity floor for recall. */
  threshold?: number;
  /** Single-tier recall restriction. */
  tier?: ResolvedTier;
  /** Whether a clean turn writes its outcome back. Default `true`. */
  remember: boolean;
  /** Tier the remembered outcome lands in. Omit for the memory's `defaultTier`. */
  rememberTier?: ResolvedTier;
  /** Context-bag key the recalled memories are injected under. */
  injectKey: string;
};

type ResolvedTier = NonNullable<OrchestratorMemoryConfig["recall"]>["tier"];

/**
 * A `MemoryContract` is the bare-store form; anything carrying a `store`
 * is the {@link OrchestratorMemoryConfig} wrapper. Distinguished by the
 * presence of `recall` — a method on the contract, absent on the config
 * (whose own `recall` is a plain options object, never a function).
 */
function isBareMemory(
  value: MemoryContract | OrchestratorMemoryConfig,
): value is MemoryContract {
  return typeof (value as MemoryContract).recall === "function";
}

/**
 * Normalize `OrchestratorConfig.memory` into {@link ResolvedOrchestratorMemory},
 * or `undefined` when no memory is configured. Centralizes the
 * bare-store-vs-config distinction so the engine context carries one
 * shape and the lifecycle phase stays branch-free.
 */
export function resolveOrchestratorMemory(
  memory: MemoryContract | OrchestratorMemoryConfig | undefined,
): ResolvedOrchestratorMemory | undefined {
  if (!memory) {
    return undefined;
  }

  if (isBareMemory(memory)) {
    return {
      store: memory,
      remember: true,
      injectKey: DEFAULT_INJECT_KEY,
    };
  }

  return {
    store: memory.store,
    k: memory.recall?.k,
    threshold: memory.recall?.threshold,
    tier: memory.recall?.tier,
    remember: memory.remember ?? true,
    rememberTier: memory.rememberTier,
    injectKey: memory.injectKey ?? DEFAULT_INJECT_KEY,
  };
}

/**
 * Coerce a turn's {@link SupervisorInput} (string or structured object)
 * into the natural-language query the memory store recalls / embeds
 * against. Strings pass through; objects are JSON-serialized — the same
 * coercion the supervisor applies when forwarding an object input to a
 * child agent without an explicit `input(ctx)` override.
 */
export function memoryQueryFromInput(input: SupervisorInput): string {
  return typeof input === "string" ? input : JSON.stringify(input);
}

/**
 * Recall the memories relevant to a turn's input (memory core M2 — the
 * pre-dispatch half). Returns the scored {@link RecalledMemory}[] the
 * lifecycle injects into the turn's `context` bag under
 * `memory.injectKey`. Returns an empty array — never throws on "no hits"
 * — and short-circuits when `k === 0` (recall disabled / write-only
 * memory) so a write-only config never round-trips the embedder.
 */
export async function recallForTurn(
  memory: ResolvedOrchestratorMemory,
  input: SupervisorInput,
): Promise<RecalledMemory[]> {
  if (memory.k === 0) {
    return [];
  }

  return memory.store.recall(memoryQueryFromInput(input), {
    k: memory.k,
    threshold: memory.threshold,
    tier: memory.tier,
  });
}

/**
 * Merge the recalled memories into a fresh per-turn context bag under
 * `memory.injectKey` (memory core M2 — the injection half). Never
 * mutates the caller's `context` object — returns a new bag (or the
 * original when there is nothing to inject) so the request-scoped input
 * stays immutable, and the supervisor's intake (which freezes a
 * shallow copy) sees the recalled set on every `ctx.context[injectKey]`.
 *
 * A pre-existing value at `injectKey` is preserved when recall produced
 * nothing, and overwritten with the recalled set otherwise — the
 * orchestrator owns that key once memory is configured.
 */
export function injectMemories(
  context: Record<string, unknown> | undefined,
  memory: ResolvedOrchestratorMemory,
  recalled: RecalledMemory[],
): Record<string, unknown> | undefined {
  if (recalled.length === 0) {
    return context;
  }

  return { ...(context ?? {}), [memory.injectKey]: recalled };
}

/**
 * Remember a settled turn's outcome (memory core M2 — the post-dispatch
 * half). Called only after a clean turn (cancelled / failed turns revert
 * and never remember — §17). No-ops when `remember` is `false`
 * (read-only memory) or when the produced text is empty.
 *
 * The remembered text is the turn input followed by the model's textual
 * outcome when one is available, so a later `recall` keyed on a similar
 * input surfaces both the prior question and its answer.
 */
export async function rememberTurnOutcome(
  memory: ResolvedOrchestratorMemory,
  input: SupervisorInput,
  outcomeText: string | undefined,
): Promise<void> {
  if (!memory.remember) {
    return;
  }

  const text = buildOutcomeText(input, outcomeText);

  if (!text) {
    return;
  }

  const item: MemoryItem = { text, tier: memory.rememberTier };

  await memory.store.remember(item);
}

/**
 * Compose the text written to memory for a turn: the input query, plus
 * the outcome text on a following line when the dispatch produced one.
 * Returns `undefined` when neither side carries content so an empty turn
 * never pollutes the store.
 */
function buildOutcomeText(
  input: SupervisorInput,
  outcomeText: string | undefined,
): string | undefined {
  const query = memoryQueryFromInput(input).trim();
  const outcome = outcomeText?.trim();

  if (query && outcome) {
    return `${query}\n${outcome}`;
  }

  return query || outcome || undefined;
}

/**
 * Derive a turn's textual outcome for remembering (memory core M2).
 * Prefers the validated `result.data` (an `output` schema reshaped it);
 * otherwise stringifies the dispatched intents' branch outputs from the
 * turn snapshot, joined newline-wise so a multi-branch fan-out
 * contributes every output. Returns `undefined` when the turn produced
 * no usable text — the caller then remembers the input alone.
 */
export function outcomeTextFromTurn(
  data: unknown,
  turnSnapshot: TurnSnapshot,
): string | undefined {
  const fromData = stringifyOutcome(data);

  if (fromData) {
    return fromData;
  }

  const outputs = Object.values(turnSnapshot.result)
    .map((branch) => stringifyOutcome(branch.output))
    .filter((text): text is string => Boolean(text));

  return outputs.length > 0 ? outputs.join("\n") : undefined;
}

/**
 * Coerce one outcome value to text: strings pass through; everything
 * else (objects, numbers) is JSON-serialized. `undefined` / `null` and
 * empty strings collapse to `undefined` so they don't masquerade as
 * content.
 */
function stringifyOutcome(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const text = typeof value === "string" ? value : JSON.stringify(value);

  return text.trim() ? text : undefined;
}
