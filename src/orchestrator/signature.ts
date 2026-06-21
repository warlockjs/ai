import type { OrchestratorConfig } from "../contracts/orchestrator/orchestrator-config.type";
import type { ResolvedIntentEntry } from "../supervisor/entries";

/**
 * Shape of the `historyWindow` config a fingerprint records. A number
 * window is recorded as `"number"`; a callback window as `"callback"`;
 * an absent role as `null`. The window VALUE (the literal `5`, the
 * callback body) is deliberately excluded — only the structural choice
 * of windowing strategy per role drifts the signature (§10.1).
 */
type HistoryWindowRoleFingerprint = "number" | "callback" | null;

/**
 * Deterministic structural fingerprint of an orchestrator definition
 * (orchestrator.md §10.1). Persisted on every checkpoint so Phase 2 can
 * refuse a turn when the live definition no longer matches the saved
 * session shape. Covers exactly the dispatch contract:
 *
 * - `name`.
 * - The `intents` map — each intent key + its resolved description +
 *   the underlying unit's stable identity (agent name, workflow name +
 *   signature, or a `"callback"` marker for dev-callback intents).
 *   Reuses the supervisor's resolved-entry fingerprinting verbatim.
 * - `route` callback presence (its body is code, not data).
 * - `router` agent identity when LLM routing is configured.
 * - `evaluate` callback presence.
 * - `initialAgent` when set.
 * - `maxIterations`.
 * - The `iterate` flag — flipping single-dispatch to delegated
 *   iteration is a semantic shape change.
 * - The `historyWindow` config SHAPE — which roles window and whether
 *   each is a number or a callback (not the window value itself).
 *
 * Does NOT cover (§10.1): `version` (metadata only), `systemPrompt`
 * text, logger config, store identities, event handlers, or callback
 * function bodies (callbacks fingerprint as their presence/`"callback"`
 * marker only). The orchestrator signature does NOT aggregate the
 * internal supervisor's signature — that is a per-run concern delegated
 * to `supervisor.resume()`'s own drift check on `iterate: true`.
 *
 * @example
 * const signature = computeOrchestratorSignature(config, resolvedEntries);
 * // "1a2b3c4d" — 8-char FNV-1a hex, stable across process restarts.
 */
export function computeOrchestratorSignature(
  config: OrchestratorConfig<unknown>,
  entries: Map<string, ResolvedIntentEntry>,
): string {
  const intentsFingerprint = [...entries.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([intent, entry]) => ({
      k: intent,
      d: entry.description,
      u: fingerprintUnit(entry),
    }));

  const fingerprint = {
    n: config.name,
    a: intentsFingerprint,
    r: resolveRouterName(config.router),
    rc: config.route ? 1 : 0,
    e: config.evaluate ? 1 : 0,
    i: config.initialAgent ?? null,
    m: config.maxIterations ?? null,
    it: config.iterate ? 1 : 0,
    hw: fingerprintHistoryWindow(config.historyWindow),
  };

  return hash(JSON.stringify(fingerprint));
}

/**
 * Router identity for the fingerprint. Accepts both the bare-agent
 * shorthand and the `{ agent, ... }` entry form, returning the agent's
 * name (or `null` when no router is configured). Mirrors the
 * supervisor's `resolveRouterName`.
 */
function resolveRouterName(router: OrchestratorConfig<unknown>["router"]): string | null {
  if (!router) {
    return null;
  }

  if (typeof (router as { execute?: unknown }).execute === "function") {
    return (router as { name?: string }).name ?? null;
  }

  return (router as { agent?: { name?: string } }).agent?.name ?? null;
}

/**
 * Structural fingerprint of the `historyWindow` config. Records the
 * windowing strategy per role (`"number"` / `"callback"` / `null`) so a
 * dev swapping a fixed-size window for a token-counting callback drifts
 * the signature, while tuning the window value (e.g. `5` → `8`) does
 * not. The window value is a runtime knob, not a shape change.
 */
function fingerprintHistoryWindow(
  historyWindow: OrchestratorConfig<unknown>["historyWindow"],
): { router: HistoryWindowRoleFingerprint; agents: HistoryWindowRoleFingerprint } {
  return {
    router: fingerprintHistoryWindowRole(historyWindow?.router),
    agents: fingerprintHistoryWindowRole(historyWindow?.agents),
  };
}

function fingerprintHistoryWindowRole(
  window: number | ((...args: never[]) => unknown) | undefined,
): HistoryWindowRoleFingerprint {
  if (window === undefined) {
    return null;
  }

  if (typeof window === "function") {
    return "callback";
  }

  return "number";
}

/**
 * Stable identity of one resolved intent's underlying unit. Agents
 * fingerprint by name; workflows by name + their own signature;
 * callbacks by a type marker only (their closure can't be hashed
 * deterministically, so drift covers add/remove/rename, not body
 * edits). Identical to the supervisor's `fingerprintUnit`.
 */
function fingerprintUnit(entry: ResolvedIntentEntry): unknown {
  if (entry.type === "callback") {
    return { t: "callback" };
  }

  if (entry.type === "workflow") {
    const workflow = entry.unit;
    return { t: "workflow", n: workflow.name, s: workflow.signature };
  }

  return { t: "agent", n: entry.unit.name };
}

/**
 * FNV-1a 32-bit — the same hash `supervisor/signature.ts` and
 * `workflow/signature.ts` use. Deterministic, no crypto dependency,
 * cheap; signatures are 8-char hex.
 */
function hash(input: string): string {
  let h = 0x811c9dc5;

  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }

  return h.toString(16).padStart(8, "0");
}
