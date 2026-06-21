import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AgentContract } from "../contracts/agent/agent.contract";
import type { Message } from "../contracts/conversation-message.type";
import { END, type EndSentinel } from "../contracts/end.type";
import type { BaseReport } from "../contracts/result/base-report.type";
import type { IterationSnapshot } from "../contracts/supervisor/iteration-snapshot.type";
import type { Next } from "../contracts/supervisor/next.type";
import type { RouteContext } from "../contracts/supervisor/route-context.type";
import type { RouterEntry } from "../contracts/supervisor/router-entry.type";
import type { SupervisorConfig } from "../contracts/supervisor/supervisor-config.type";
import type { SupervisorInput } from "../contracts/supervisor/supervisor-input.type";
import { AIError, SupervisorFailedError, SupervisorRoutingError } from "../errors";
import type { ResolvedIntentEntry } from "./entries";
import { buildRouterContextMessage } from "./router-prompt";

/**
 * Outcome of one dispatch decision — what the iteration loop needs to
 * act on. `kind: "end"` signals termination; `kind: "dispatch"` carries
 * the resolved intents (always an array; single-agent dispatch has
 * length 1). `source` records which path made the call so the
 * iteration snapshot can surface it to debuggers.
 */
export type DispatchDecision =
  | {
      kind: "end";
      source: "route" | "router" | "initialAgent" | "classifier";
      raw: Next;
      reasoning?: string;
      durationMs: number;
      usage?: { input: number; output: number; total: number };
      /** Full router-agent report when this decision came from a router. */
      routerReport?: BaseReport;
    }
  | {
      kind: "dispatch";
      intents: string[];
      source: "route" | "router" | "initialAgent" | "classifier";
      raw: Next;
      reasoning?: string;
      durationMs: number;
      usage?: { input: number; output: number; total: number };
      /** Full router-agent report when this decision came from a router. */
      routerReport?: BaseReport;
    };

export type DecideParams = {
  config: SupervisorConfig<unknown>;
  entries: Map<string, ResolvedIntentEntry>;
  iteration: number;
  maxIterations: number;
  iterations: IterationSnapshot[];
  input: SupervisorInput;
  /**
   * Per-execute state accumulator at the start of this iteration.
   * Threaded into `RouteContext` for the route callback and
   * rendered into the router prompt so routing decisions can be
   * state-aware (Q14).
   */
  state: Record<string, unknown>;
  /**
   * Frozen request-scoped bag from the `execute({ context })` call —
   * surfaced on `RouteContext.context` for both `route` callbacks
   * and `RouterEntry.placeholders` / `RouterEntry.input` resolvers.
   */
  context: Readonly<Record<string, unknown>>;
  /**
   * Frozen prior-conversation history from `execute({ history })` —
   * surfaced on `RouteContext.history` and forwarded to the router
   * agent as `agent.execute(input, { history })` so router decisions
   * are conversation-aware.
   */
  history: ReadonlyArray<Message>;
  /**
   * Resolved natural-language objective from `SupervisorConfig.goal`
   * (materialized to plain text at supervisor construction). Surfaced
   * on `RouteContext.goal` for `route` / `RouterEntry` resolvers, and
   * injected into the router agent's per-turn user message via
   * `buildRouterContextMessage`. `undefined` when no goal was set.
   */
  goal: string | undefined;
  evaluateFeedback?: RouteContext["evaluateFeedback"];
  /**
   * Forensic record of the iter-0 classifier (Phase 7). Threaded into
   * `RouteContext.classifier` so route callbacks and router-agent
   * input composers can read the classification trail without
   * re-parsing state.
   */
  classifier?: RouteContext["classifier"];
  signal?: AbortSignal;
  /**
   * Override for the very first iteration — when `initialAgent` is
   * set, the first turn skips `route`/`router` and dispatches the
   * named intent directly. `runIteration` passes `true` only on turn
   * 0 when the config has `initialAgent`.
   */
  useInitialAgent?: boolean;
};

/**
 * Unified dispatch decision entry — calls either the `route` callback
 * or the `router` agent based on the supervisor's configured mode and
 * normalizes the result into a `DispatchDecision`. Runtime validates
 * every routing value against the configured agent keys; unknown keys
 * surface as `SupervisorRoutingError`.
 */
export async function decide(params: DecideParams): Promise<DispatchDecision> {
  if (params.useInitialAgent && params.config.initialAgent) {
    const intent = params.config.initialAgent;
    validateKey(intent, params.entries);

    return {
      kind: "dispatch",
      intents: [intent],
      source: "initialAgent",
      raw: intent,
      durationMs: 0,
    };
  }

  if (params.config.route) {
    return decideViaCallback(params);
  }

  if (params.config.router) {
    return decideViaRouter(params);
  }

  throw new SupervisorFailedError(
    `ai.supervisor("${params.config.name}"): neither \`route\` nor \`router\` is configured — factory validation should have prevented this`,
    { context: { authoring: true } },
  );
}

async function decideViaCallback(params: DecideParams): Promise<DispatchDecision> {
  const started = performance.now();
  const ctx: RouteContext = {
    iteration: params.iteration,
    input: params.input,
    state: params.state,
    iterations: params.iterations,
    feedback:
      typeof params.evaluateFeedback?.feedback === "string"
        ? params.evaluateFeedback.feedback
        : undefined,
    evaluateFeedback: params.evaluateFeedback,
    context: params.context,
    history: params.history,
    goal: params.goal,
    classifier: params.classifier,
  };

  let raw: Next;

  try {
    raw = await params.config.route!(ctx);
  } catch (thrown) {
    throw wrapRouteError(params.config.name, thrown);
  }

  const durationMs = performance.now() - started;

  return normalize(raw, params.entries, "route", durationMs);
}

async function decideViaRouter(params: DecideParams): Promise<DispatchDecision> {
  const { agent, placeholders, inputOverride, historySlicer } = resolveRouterEntry(
    params.config.router!,
  );
  const started = performance.now();

  const routeCtx: RouteContext = {
    iteration: params.iteration,
    input: params.input,
    state: params.state,
    iterations: params.iterations,
    feedback:
      typeof params.evaluateFeedback?.feedback === "string"
        ? params.evaluateFeedback.feedback
        : undefined,
    evaluateFeedback: params.evaluateFeedback,
    context: params.context,
    history: params.history,
    goal: params.goal,
  };

  const userMessage =
    inputOverride?.(routeCtx) ??
    buildRouterContextMessage({
      entries: params.entries,
      iteration: params.iteration,
      maxIterations: params.maxIterations,
      iterations: params.iterations,
      input: params.input,
      state: params.state,
      feedback: routeCtx.feedback,
      supervisorPrompt: resolveSupervisorPromptText(params.config),
      goal: params.goal,
    });

  const resolvedPlaceholders = placeholders?.(routeCtx);

  // Inject the canonical router output schema so the supervisor gets
  // a predictable `{ next, reasoning? }` shape regardless of what the
  // user scripted on the router agent. Lets the router stay a plain
  // agent — no supervisor-specific config needed at construction.
  const routerHistory = resolveRouterHistory(
    historySlicer,
    routeCtx,
    params.history,
    params.config.historyWindow?.router,
  );

  const routerResult = await agent.execute(userMessage, {
    signal: params.signal,
    output: ROUTER_OUTPUT_SCHEMA as unknown as StandardSchemaV1<{
      next: Next;
      reasoning?: string;
    }>,
    ...(resolvedPlaceholders ? { placeholders: resolvedPlaceholders } : {}),
    ...(routerHistory.length > 0 ? { history: routerHistory } : {}),
  });

  const durationMs = performance.now() - started;

  if (routerResult.error) {
    throw routerResult.error instanceof AIError
      ? routerResult.error
      : new SupervisorFailedError(`router agent failed`, {
          cause: routerResult.error,
        });
  }

  const data = routerResult.data;

  if (!data || typeof data !== "object") {
    throw new SupervisorRoutingError(
      `router agent returned no structured \`next\` — did its output schema include { next, reasoning? }?`,
      { returned: data, availableKeys: [...params.entries.keys()] },
    );
  }

  const rawNext = (data as { next?: unknown }).next;
  const reasoning = (data as { reasoning?: unknown }).reasoning;

  if (rawNext === undefined) {
    throw new SupervisorRoutingError(`router agent output missing \`next\` field`, {
      returned: data,
      availableKeys: [...params.entries.keys()],
    });
  }

  const decision = normalize(rawNext as Next, params.entries, "router", durationMs);

  return {
    ...decision,
    reasoning: typeof reasoning === "string" ? reasoning : undefined,
    usage: routerResult.usage,
    routerReport: routerResult.report,
  };
}

/**
 * Normalize the `router` config field — accepts either a bare
 * `AgentContract` (shorthand) or a full `RouterEntry` — into a
 * uniform `{ agent, placeholders?, inputOverride? }` triple. Centralized
 * so the dispatch path doesn't branch on shape.
 */
function resolveRouterEntry(router: AgentContract<unknown> | RouterEntry): {
  agent: AgentContract<unknown>;
  placeholders?: RouterEntry["placeholders"];
  inputOverride?: RouterEntry["input"];
  historySlicer?: RouterEntry["history"];
} {
  if (typeof (router as { execute?: unknown }).execute === "function") {
    return { agent: router as AgentContract<unknown> };
  }

  const entry = router as RouterEntry;

  return {
    agent: entry.agent,
    placeholders: entry.placeholders,
    inputOverride: entry.input,
    historySlicer: entry.history,
  };
}

/**
 * Resolve the supervisor's own `systemPrompt` (string or contract)
 * into plain text. Returns `undefined` when the supervisor didn't
 * configure one. The resolved text is surfaced in the per-turn
 * router user message so the router sees team/domain context without
 * disturbing the router agent's own factory-level system prompt —
 * functionally equivalent to prepending, without requiring an API
 * expansion on `AgentContract` to read the router's system prompt.
 */
function resolveSupervisorPromptText(config: SupervisorConfig<unknown>): string | undefined {
  if (!config.systemPrompt) {
    return undefined;
  }

  return typeof config.systemPrompt === "string"
    ? config.systemPrompt
    : config.systemPrompt.resolve();
}

/**
 * Convert the raw routing value (callback return OR router agent
 * `next` field) into a canonical `DispatchDecision`, validating every
 * named intent against the supervisor's `intents` map.
 */
function normalize(
  raw: Next,
  entries: Map<string, ResolvedIntentEntry>,
  source: "route" | "router",
  durationMs: number,
): DispatchDecision {
  if (isEnd(raw)) {
    return { kind: "end", source, raw, durationMs };
  }

  if (typeof raw === "string") {
    validateKey(raw, entries);

    return {
      kind: "dispatch",
      intents: [raw],
      source,
      raw,
      durationMs,
    };
  }

  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      throw new SupervisorRoutingError(
        `router returned an empty array — must be a non-empty list of agent intents`,
        { returned: raw, availableKeys: [...entries.keys()] },
      );
    }

    for (const intent of raw) {
      if (typeof intent !== "string") {
        throw new SupervisorRoutingError(`router returned a non-string inside its fan-out array`, {
          returned: raw,
          availableKeys: [...entries.keys()],
        });
      }

      validateKey(intent, entries);
    }

    return {
      kind: "dispatch",
      intents: raw,
      source,
      raw,
      durationMs,
    };
  }

  throw new SupervisorRoutingError(
    `router returned an unsupported value — expected a string, string[], or END`,
    { returned: raw, availableKeys: [...entries.keys()] },
  );
}

function validateKey(intent: string, entries: Map<string, ResolvedIntentEntry>): void {
  if (!entries.has(intent)) {
    throw new SupervisorRoutingError(`router returned unknown agent key "${intent}"`, {
      returned: intent,
      availableKeys: [...entries.keys()],
    });
  }
}

function isEnd(value: unknown): value is EndSentinel {
  return value === END;
}

/**
 * Resolve the history slice forwarded to the router agent. Mirrors
 * `SupervisorExecution.resolveHistoryFor("router", ...)` — duplicated
 * here so the standalone `decide()` function stays callable without
 * threading the execution instance through. Precedence is identical:
 * entry slicer > `historyWindow.router` > full history.
 */
function resolveRouterHistory(
  slicer: RouterEntry["history"] | undefined,
  routeCtx: RouteContext,
  full: ReadonlyArray<Message>,
  window: number | undefined,
): Message[] {
  if (slicer) {
    const sliced = slicer(routeCtx);
    return sliced ? [...sliced] : [];
  }

  if (window === undefined || window < 0) {
    return [...full];
  }

  if (window === 0) {
    return [];
  }

  return full.slice(-window);
}

/**
 * JSON Schema form of the canonical router output shape. Surfaced via
 * the Standard JSON Schema V1 extension path (`["~standard"].jsonSchema.input`)
 * so `extractJsonSchema()` can pull it for native structured-output
 * enforcement on capable providers (OpenAI strict json_schema mode,
 * Anthropic tool-use shape, etc.). Without this, the model is told to
 * emit JSON only via soft system-prompt instruction — fragile, and
 * skipped entirely when the model advertises `structuredOutput: true`.
 *
 * `next` is intentionally `string` (not a union with arrays) because
 * OpenAI strict mode rejects polymorphic root types — fan-out via
 * `string[]` is still validated at the framework layer; the model
 * just emits a single intent name (or the END sentinel) and the
 * supervisor's own normalizer handles the rest.
 */
const ROUTER_OUTPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    next: {
      type: "string",
      description: "Name of the agent to dispatch next, or the END sentinel to terminate the run.",
    },
    reasoning: {
      type: "string",
      description: "One-sentence justification for the routing choice.",
    },
  },
  required: ["next", "reasoning"],
  additionalProperties: false,
};

/**
 * Canonical Standard Schema the supervisor injects when calling the
 * router agent. Pragmatic — accepts any `next` shape the router can
 * plausibly emit (`string`, `string[]`, or the `END` literal) plus an
 * optional `reasoning` field. Rejects anything else so a broken
 * router output surfaces cleanly via the agent's own validation path.
 *
 * Exposes `["~standard"].jsonSchema.input()` (Standard JSON Schema V1)
 * so capable providers enforce the shape natively rather than relying
 * on prompt-side coaching.
 */
const ROUTER_OUTPUT_SCHEMA: StandardSchemaV1<{
  next: Next;
  reasoning?: string;
}> = {
  "~standard": {
    version: 1,
    vendor: "warlock-supervisor",
    jsonSchema: {
      input: () => ROUTER_OUTPUT_JSON_SCHEMA,
    },
    validate(value: unknown): StandardSchemaV1.Result<{ next: Next; reasoning?: string }> {
      if (!value || typeof value !== "object") {
        return { issues: [{ message: "router output must be an object" }] };
      }

      const record = value as { next?: unknown; reasoning?: unknown };
      const rawNext = record.next;

      const nextIsValid =
        typeof rawNext === "string" ||
        (Array.isArray(rawNext) && rawNext.every((element) => typeof element === "string"));

      if (!nextIsValid) {
        return {
          issues: [
            {
              message: "router output `next` must be a string, string[], or the END sentinel",
            },
          ],
        };
      }

      const reasoning = typeof record.reasoning === "string" ? record.reasoning : undefined;

      return {
        value: { next: rawNext as Next, reasoning },
      };
    },
  } as StandardSchemaV1<{ next: Next; reasoning?: string }>["~standard"] & {
    jsonSchema: { input: () => Record<string, unknown> };
  },
};

function wrapRouteError(supervisorName: string, thrown: unknown): AIError {
  if (thrown instanceof AIError) {
    return thrown;
  }

  const message = thrown instanceof Error ? thrown.message : String(thrown);

  return new SupervisorFailedError(
    `\`route\` callback threw in supervisor "${supervisorName}": ${message}`,
    { cause: thrown },
  );
}
