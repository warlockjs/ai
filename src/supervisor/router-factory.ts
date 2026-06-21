import type { StandardSchemaV1 } from "@standard-schema/spec";
import { agent } from "../agent/agent";
import type { AgentEventHandlers } from "../agent/agent-config.type";
import type { AgentContract } from "../contracts/agent/agent.contract";
import { END } from "../contracts/end.type";
import type { ModelCallOptions, ModelContract } from "../contracts/model.contract";
import type { Placeholders } from "../contracts/placeholders.type";
import type { SupervisorIntentValue } from "../contracts/supervisor/intent-entry.type";
import type { Next } from "../contracts/supervisor/next.type";
import type { SystemPromptContract } from "../contracts/system-prompt.contract";

/**
 * Output shape every router agent produced by {@link router} emits —
 * the canonical `{ next, reasoning }` contract the supervisor's
 * dispatch loop reads. Exposed so callers can type a router result
 * they handle directly.
 */
export type RouterOutput = {
  /** Chosen intent name, a fan-out array, or the `END` sentinel. */
  next: Next;
  /** One-sentence justification for the routing choice. */
  reasoning: string;
};

/**
 * Description source for one intent the router can pick from. Accepts
 * the same value-shapes the supervisor's `intents` map does (bare
 * agent / workflow / callback / object entry) so a caller can pass the
 * very same `intents` object to both `router()` and `ai.supervisor()`.
 *
 * The router only needs each intent's NAME (the map key) and a
 * human-readable DESCRIPTION — it never dispatches anything itself, so
 * the underlying unit is read for its `description` only.
 */
export type RouterIntents = Record<string, SupervisorIntentValue>;

/**
 * Config for {@link router}. Mirrors the relevant slice of `AgentConfig`
 * — the router IS an agent — plus the `intents` map it routes over.
 *
 * Everything except `model` and `intents` is optional; the helper
 * generates the output schema and the routing system prompt for you.
 */
export type RouterConfig = {
  /**
   * Stable identifier for the router agent. Defaults to
   * `"<supervisor-ish>-router"` is NOT assumed — when omitted the helper
   * uses `"router"` so the agent carries a meaningful (non-anonymous)
   * name, which `ai.supervisor({ router })` is happy to accept.
   */
  name?: string;
  /** The routing LLM. Required — a router with no model can't decide. */
  model: ModelContract;
  /**
   * The intents the router chooses among. Same object you pass to
   * `ai.supervisor({ intents })`. Their descriptions are rendered into
   * the generated routing system prompt so the LLM knows what each
   * option does.
   */
  intents: RouterIntents;
  /**
   * Extra guidance prepended to the framework-generated routing system
   * prompt. Use it for domain framing ("You coordinate a support
   * team."); the mechanical "here are your options, emit `next`"
   * scaffolding is appended automatically.
   */
  systemPrompt?: SystemPromptContract | string;
  /** Placeholder values merged into the router's system prompt template. */
  placeholders?: Placeholders;
  /** Base model call options forwarded to the underlying agent. */
  modelOptions?: ModelCallOptions;
  /**
   * Hard cap on LLM trips for the router agent. A router is a
   * single-shot decision maker, so this defaults to `1` — override
   * only if the router itself calls tools mid-decision.
   */
  maxTrips?: number;
  /** Factory-level event handlers forwarded to the underlying agent. */
  on?: AgentEventHandlers;
};

/**
 * Build a routing agent for `ai.supervisor({ router })` without
 * hand-writing the output schema or the "pick one of these intents"
 * system prompt.
 *
 * **What it does for you.**
 * - Generates the canonical `{ next, reasoning }` output schema
 *   (baked onto the agent so it's a valid router standalone, and
 *   identical to what the supervisor injects per-turn) — the model is
 *   steered to emit a single intent name or the `END` sentinel.
 * - Auto-builds a system prompt that lists every intent + its
 *   description + the reserved `END` value + terse routing rules, with
 *   any caller-supplied `systemPrompt` framing kept on top.
 *
 * The result is a plain {@link AgentContract}; pass it straight to
 * `ai.supervisor({ router: ... })`. Because the supervisor also injects
 * the same schema per-turn and prepends its own per-turn context
 * message, the baked schema/prompt are belt-and-suspenders — they make
 * the agent a correct router even when invoked directly.
 *
 * @example
 * const intents = { triage, orderLookup, billingLookup, resolver };
 *
 * const supportRouter = ai.router({
 *   model,
 *   intents,
 *   systemPrompt: "You coordinate a customer-support team.",
 * });
 *
 * const support = ai.supervisor({
 *   name: "customer-support",
 *   router: supportRouter,
 *   intents,
 *   maxIterations: 6,
 * });
 */
export function router(config: RouterConfig): AgentContract<RouterOutput> {
  if (!config.model) {
    throw new TypeError("ai.router: `model` is required");
  }

  if (!config.intents || typeof config.intents !== "object") {
    throw new TypeError("ai.router: `intents` is required and must be an object");
  }

  const intentNames = Object.keys(config.intents);

  if (intentNames.length === 0) {
    throw new TypeError("ai.router: `intents` must contain at least one entry");
  }

  const routingPrompt = buildRoutingSystemPrompt(config.intents, resolvePrefix(config.systemPrompt));

  return agent<RouterOutput>({
    name: config.name ?? "router",
    description: "Routes a supervisor run to the next intent (or terminates it).",
    model: config.model,
    systemPrompt: routingPrompt,
    output: routerOutputSchema(intentNames),
    placeholders: config.placeholders,
    modelOptions: config.modelOptions,
    maxTrips: config.maxTrips ?? 1,
    on: config.on,
  });
}

/**
 * Resolve a caller-supplied `systemPrompt` (string or contract) to
 * plain text for prepending to the generated routing block. Returns
 * `undefined` when none was supplied.
 */
function resolvePrefix(prompt: SystemPromptContract | string | undefined): string | undefined {
  if (!prompt) {
    return undefined;
  }

  return typeof prompt === "string" ? prompt : prompt.resolve();
}

/**
 * Assemble the routing system prompt: optional caller framing on top,
 * then the mechanical block listing every intent + description, the
 * reserved `END` sentinel, and the rules for emitting `next`.
 */
function buildRoutingSystemPrompt(intents: RouterIntents, prefix: string | undefined): string {
  const intentLines = Object.entries(intents).map(([name, value]) => {
    const description = resolveIntentDescription(value);

    return description ? `- ${name}: ${description}` : `- ${name}`;
  });

  const sections: string[] = [];

  if (prefix && prefix.trim().length > 0) {
    sections.push(prefix.trim(), "");
  }

  sections.push(
    "You are a router. Pick the single best intent to handle the next step, or terminate the run.",
    "",
    "Available intents:",
    ...intentLines,
    "",
    "Reserved values:",
    `- ${END} = terminate the run when no further intent is needed`,
    "",
    "Rules:",
    "- Respond with the `next` field set to exactly one intent name from the list above, or the END sentinel.",
    "- Put a one-sentence justification in the `reasoning` field.",
    "- Never invent an intent name that is not listed.",
  );

  return sections.join("\n");
}

/**
 * Read the human-readable description off a supervisor-intent value,
 * regardless of which accepted shape it is (bare agent / workflow,
 * object entry with a `description` override, callback entry). Bare
 * callbacks have no description source — returns `undefined`, and the
 * prompt simply lists the intent by name.
 */
function resolveIntentDescription(value: SupervisorIntentValue): string | undefined {
  if (!value || typeof value === "function") {
    return undefined;
  }

  const entry = value as {
    description?: unknown;
    agent?: { description?: unknown };
  };

  if (typeof entry.description === "string" && entry.description.trim().length > 0) {
    return entry.description.trim();
  }

  const agentDescription = entry.agent?.description;

  if (typeof agentDescription === "string" && agentDescription.trim().length > 0) {
    return agentDescription.trim();
  }

  return undefined;
}

/**
 * Build the canonical router output Standard Schema. The same shape the
 * supervisor injects per-turn — `{ next: string, reasoning: string }` —
 * with the JSON Schema extension carrying the intent names as an `enum`
 * (plus the `END` sentinel) so capable providers enforce the choice
 * natively rather than via soft prompt coaching. Validation still
 * accepts `string` / `string[]` for framework-level fan-out.
 */
function routerOutputSchema(intentNames: string[]): StandardSchemaV1<RouterOutput> {
  const nextEnum = [...intentNames, END];

  const jsonSchema = {
    type: "object",
    properties: {
      next: {
        type: "string",
        enum: nextEnum,
        description: "Name of the intent to dispatch next, or the END sentinel to terminate.",
      },
      reasoning: {
        type: "string",
        description: "One-sentence justification for the routing choice.",
      },
    },
    required: ["next", "reasoning"],
    additionalProperties: false,
  };

  return {
    "~standard": {
      version: 1,
      vendor: "warlock-router",
      jsonSchema: {
        input: () => jsonSchema,
      },
      validate(value: unknown): StandardSchemaV1.Result<RouterOutput> {
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
              { message: "router output `next` must be a string, string[], or the END sentinel" },
            ],
          };
        }

        const reasoning = typeof record.reasoning === "string" ? record.reasoning : "";

        return {
          value: { next: rawNext as Next, reasoning },
        };
      },
    } as StandardSchemaV1<RouterOutput>["~standard"] & {
      jsonSchema: { input: () => Record<string, unknown> };
    },
  };
}
