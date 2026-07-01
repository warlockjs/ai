import type { AgentConfig } from "./agent-config.type";

/**
 * Deterministic structural fingerprint of an agent definition.
 * Persisted on every durable snapshot so `agent.resume()` can detect
 * drift between the saved run and the current definition. Covers the
 * fields whose change would make a mid-run resume unsafe — i.e. would
 * make the persisted `messages` / `toolCalls` array inconsistent with
 * what the resumed trip loop would produce:
 *
 * - Model name + provider — a different model invalidates the prior
 *   conversation's continuation.
 * - The sorted tool names — adding / removing / renaming a tool changes
 *   which dispatches the persisted `toolCalls` could have come from.
 * - `maxTrips` — the loop bound is a semantic shape change.
 * - Whether a default `output` schema is configured — flips the
 *   structured-output instruction baked into the system turn.
 * - `version` — dev-curated; a bump is an explicit "this changed" signal.
 *
 * Does NOT cover: system-prompt text, middleware, per-event handlers,
 * placeholders, modelOptions — runtime knobs that don't change the
 * shape of a resumable run. Mirrors `supervisor/signature.ts`'s coarse
 * structural philosophy and reuses its FNV-1a `hash`.
 *
 * `tools` here is read off the resolved config (post-normalization), so
 * raw executables dropped into `tools: []` are already adapted to
 * `ToolContract`s carrying a stable `name`.
 */
export function computeAgentSignature(config: {
  name?: string;
  version?: AgentConfig["version"];
  model: { name?: string; provider?: string };
  tools?: ReadonlyArray<{ name: string }>;
  maxTrips?: number;
  output?: unknown;
}): string {
  const toolNames = (config.tools ?? [])
    .map((tool) => tool.name)
    .sort((a, b) => a.localeCompare(b));

  const fingerprint = {
    n: config.name ?? null,
    p: config.model?.provider ?? null,
    m: config.model?.name ?? null,
    t: toolNames,
    x: config.maxTrips ?? null,
    o: config.output ? 1 : 0,
    v: config.version ?? null,
  };

  return hash(JSON.stringify(fingerprint));
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
