import { ClassifierAgentEntry, ClassifierRunEntry } from "../contracts";
import type { SupervisorConfig } from "../contracts/supervisor/supervisor-config.type";
import type { ResolvedIntentEntry } from "./entries";

/**
 * Deterministic structural fingerprint of a supervisor definition.
 * Persisted on every snapshot so `resume()` can detect drift between
 * the saved run and the current definition. Covers:
 *
 * - Supervisor name.
 * - Every intent key + its resolved description + the underlying
 *   unit's stable identity (agent name, workflow name + signature,
 *   or `"callback"` marker for dev-callback intents).
 * - Router agent's name (if the supervisor uses LLM routing).
 * - Whether a deterministic `route` callback is configured (but not
 *   its contents — route callbacks are code, not data).
 * - Whether an `evaluate` callback is configured.
 * - `initialAgent` when set.
 * - `maxIterations` (a semantic shape change, not a cosmetic one).
 *
 * Does NOT cover: system prompt text, logger, store identity, per-
 * event handlers — all runtime knobs that don't change the shape of
 * a resumable run.
 */
export function computeSignature(
  config: SupervisorConfig<unknown>,
  entries: Map<string, ResolvedIntentEntry>,
): string {
  const intentsFingerprint = [...entries.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
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
    // Phase 7 / decisions §37 — classifier is part of structural identity.
    // Resume drift detection notices when the classifier swap changes
    // routing semantics. Same fingerprint shape as router (agent name
    // when applicable; "callback" marker for callback form).
    c: resolveClassifierFingerprint(config.classifier),
  };

  return hash(JSON.stringify(fingerprint));
}

function resolveRouterName(router: SupervisorConfig<unknown>["router"]): string | null {
  if (!router) {
    return null;
  }

  if (typeof (router as { execute?: unknown }).execute === "function") {
    return (router as { name?: string }).name ?? null;
  }

  return (router as { agent?: { name?: string } }).agent?.name ?? null;
}

function resolveClassifierFingerprint(
  classifier: SupervisorConfig<unknown>["classifier"],
): unknown {
  if (!classifier) {
    return null;
  }

  if (typeof classifier === "function") {
    return { t: "callback" };
  }

  if (typeof (classifier as { execute?: unknown }).execute === "function") {
    return { t: "agent", n: (classifier as { name?: string }).name ?? null };
  }

  if (typeof (classifier as ClassifierRunEntry).run === "function") {
    return { t: "callback" };
  }

  if (typeof (classifier as ClassifierAgentEntry).agent?.execute === "function") {
    return {
      t: "agent",
      n: (classifier as ClassifierAgentEntry).agent?.name ?? null,
    };
  }

  return { t: "unknown" };
}

function fingerprintUnit(entry: ResolvedIntentEntry): unknown {
  if (entry.type === "callback") {
    // Callbacks are dev code — fingerprint the type + intent name
    // only (the closure itself can't be hashed deterministically).
    // Drift detection covers add/remove/rename of callback intents,
    // not edits to the function body. Same trade-off as `route`.
    return { t: "callback" };
  }

  if (entry.type === "workflow") {
    const workflow = entry.unit;
    return { t: "workflow", n: workflow.name, s: workflow.signature };
  }

  return { t: "agent", n: entry.unit.name };
}

/**
 * FNV-1a 32-bit — same hash `workflow/signature.ts` uses. Deterministic,
 * no crypto dependency, cheap; signatures are 8-char hex.
 */
function hash(input: string): string {
  let h = 0x811c9dc5;

  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }

  return h.toString(16).padStart(8, "0");
}
