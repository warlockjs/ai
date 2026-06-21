import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AgentContract } from "../contracts/agent/agent.contract";
import type { Message } from "../contracts/conversation-message.type";
import type { EndSentinel } from "../contracts/end.type";
import type { AgentResult } from "../contracts/result/agent-result.type";
import type { WorkflowResult } from "../contracts/result/workflow-result.type";
import type { DispatchContext } from "../contracts/supervisor/dispatch-context.type";
import type {
  DispatchRawResult,
  IntentCallback,
  IntentEntry,
  IntentRunEntry,
  SupervisorIntentValue,
} from "../contracts/supervisor/intent-entry.type";
import type { RouteContext } from "../contracts/supervisor/route-context.type";
import type { SupervisorConfig } from "../contracts/supervisor/supervisor-config.type";
import type { WorkflowInstance } from "../contracts/workflow/workflow.contract";
import { SupervisorFailedError } from "../errors";

/**
 * Normalized internal representation of one entry in a supervisor's
 * `intents` map — resolved at factory time from one of the accepted
 * value forms (bare agent / workflow / callback / object entry).
 *
 * Carrying the explicit `type` discriminator keeps downstream code
 * (execution, signature, router-prompt) from having to re-detect
 * shape on every dispatch. The discriminated union below replaces
 * the flat-shape used in Phase 3 so callbacks can carry their own
 * function reference + dispatch-context-shaped resolvers.
 *
 * Discriminator renamed `kind` → `type` (Q12) for codebase-wide
 * consistency — every other discriminated result/report shape uses
 * `type`.
 */
export type ResolvedIntentEntry =
  | ResolvedAgentEntry
  | ResolvedWorkflowEntry
  | ResolvedCallbackEntry;

/**
 * Successor directive function type — the resolver-time projection of
 * `IntentEntry.next` / `IntentRunEntry.next`. Single source of truth
 * across the three resolved variants.
 */
export type IntentNext = (ctx: DispatchContext) => string | string[] | EndSentinel | undefined;

/**
 * Resolver-time projection of `IntentEntry.history` /
 * `RouterEntry.history` / `AckEntry.history`. Custom slicer that
 * REPLACES the default `historyWindow.<role>` slice.
 */
export type EntryHistorySlicer = (ctx: RouteContext) => Message[] | ReadonlyArray<Message>;

export type ResolvedAgentEntry = {
  intent: string;
  type: "agent";
  unit: AgentContract<unknown>;
  description: string;
  input?: (ctx: RouteContext) => string;
  /**
   * Per-dispatch placeholder values for the agent's systemPrompt
   * template. Forwarded as `agent.execute(input, { placeholders })`.
   * Phase 3.4 (Stage 4b) — replaces the dropped `composeAgentInput`
   * mechanism for threading state into agents.
   */
  placeholders?: (ctx: DispatchContext) => Record<string, unknown>;
  /**
   * Schema declaring this intent's slice of supervisor state. Agent
   * output is strip-merged against it; only validated keys appear on
   * `IterationSnapshot.result[intent].output` AND merge into
   * supervisor `state`.
   */
  output?: StandardSchemaV1<unknown>;
  /**
   * Successor directive (Stage 4d / Q24). When present, runs after
   * this branch's slice merges into state to choose the next dispatch
   * (or terminate) without invoking the router.
   */
  next?: IntentNext;
  /**
   * Custom history slicer — replaces the default
   * `historyWindow.agents` slice when supplied. See `IntentEntry.history`.
   */
  history?: EntryHistorySlicer;
  /**
   * Phase 5 / decisions §34. `"stream"` runs the agent without
   * structured-output coercion and writes the assembled prose into
   * `state[streamTo]`; `"structured"` is the default. Resolved at
   * factory time — `undefined` here is treated as `"structured"`.
   */
  mode?: "structured" | "stream";
  /** State key the assembled stream-mode prose writes into. Set iff `mode === "stream"`. */
  streamTo?: string;
};

export type ResolvedWorkflowEntry = {
  intent: string;
  type: "workflow";
  unit: WorkflowInstance<unknown, unknown>;
  description: string;
  input?: (ctx: RouteContext) => string;
  placeholders?: (ctx: DispatchContext) => Record<string, unknown>;
  output?: StandardSchemaV1<unknown>;
  next?: IntentNext;
  history?: EntryHistorySlicer;
};

export type ResolvedCallbackEntry = {
  intent: string;
  type: "callback";
  /**
   * The callback that actually runs at dispatch time. Always present
   * regardless of whether the user passed bare-function shorthand or
   * the `{ run, ... }` entry form.
   */
  callback: IntentCallback;
  /**
   * Description is required only when the supervisor uses a router.
   * Callback intents under a router are validated separately
   * (see {@link assertRouterDescriptions}); under deterministic
   * `route` mode this field is `undefined`.
   */
  description?: string;
  /**
   * Per-intent input resolver. Receives the upcoming
   * `DispatchContext` and returns the value forwarded as
   * `ctx.input` to the callback.
   */
  input?: (ctx: DispatchContext) => unknown;
  placeholders?: (ctx: DispatchContext) => Record<string, unknown>;
  /**
   * Schema declaring this callback's slice of state. Without it, the
   * full return value shallow-merges; with it, return is strip-merged
   * to declared keys before merging.
   */
  output?: StandardSchemaV1<unknown>;
  next?: IntentNext;
};

/**
 * Validate and normalize the `intents` map into resolved entries.
 * Runs at factory time — throws `SupervisorFailedError` on the first
 * malformed entry so author-time bugs surface immediately rather
 * than mid-run.
 *
 * Validation rules:
 * - Every value must be an agent, a workflow, a callback function,
 *   or an object entry with `agent` / `workflow` / `run`.
 * - Object entries with more than one of `{ agent, workflow, run }`
 *   throw with code `SUPERVISOR_INTENT_MIXED_DISPATCH`.
 * - Agent / workflow / agent-shaped entries must resolve to a
 *   non-empty description from the underlying unit or the entry's
 *   `description` override. Bare callback shorthand has no
 *   description source — that's enforced separately by
 *   {@link assertRouterDescriptions} when a router is configured.
 */
export function resolveIntentEntries(
  rawIntents: Record<string, SupervisorIntentValue>,
  supervisorName: string,
): Map<string, ResolvedIntentEntry> {
  const entries = Object.entries(rawIntents);

  if (entries.length === 0) {
    throw new SupervisorFailedError(
      `ai.supervisor("${supervisorName}"): \`intents\` must contain at least one entry`,
      { context: { authoring: true } },
    );
  }

  const resolved = new Map<string, ResolvedIntentEntry>();

  for (const [intent, value] of entries) {
    if (!intent || typeof intent !== "string") {
      throw new SupervisorFailedError(
        `ai.supervisor("${supervisorName}"): every \`intents\` key must be a non-empty string`,
        { context: { authoring: true } },
      );
    }

    resolved.set(intent, resolveOne(intent, value, supervisorName));
  }

  return resolved;
}

/**
 * Construction-time guard: when the supervisor is configured with a
 * `router`, every intent must resolve to a non-empty description so
 * the router LLM has a signal for picking it. Bare callback
 * shorthand and `IntentRunEntry` without `description` fail this
 * check; agents and workflows whose underlying primitive lacks a
 * description fail too — same uniform error message.
 *
 * Deterministic `route` callers skip this check entirely.
 */
export function assertRouterDescriptions(
  config: SupervisorConfig<unknown>,
  entries: Map<string, ResolvedIntentEntry>,
): void {
  if (!config.router) {
    return;
  }

  for (const [intent, entry] of entries) {
    const description = entry.type === "callback" ? entry.description : entry.description;

    if (description && description.trim().length > 0) {
      continue;
    }

    const fix =
      entry.type === "callback"
        ? "upgrade the bare callback to `{ run, description }`"
        : "set `description` on the agent/workflow or via the `IntentEntry` `description` override";

    throw new SupervisorFailedError(
      `ai.supervisor("${config.name}"): intents["${intent}"] needs a description because a \`router\` is configured — ${fix}`,
      { context: { authoring: true, intent } },
      "SUPERVISOR_INTENT_DESCRIPTION_REQUIRED",
    );
  }
}

function resolveOne(
  intent: string,
  value: SupervisorIntentValue,
  supervisorName: string,
): ResolvedIntentEntry {
  // (c) Bare callback shorthand — typeof function. Highest priority
  // so a user passing `(ctx) => …` never accidentally matches the
  // object-shape branches below.
  if (typeof value === "function") {
    return {
      intent,
      type: "callback",
      callback: value as IntentCallback,
      description: undefined,
    };
  }

  if (!value || typeof value !== "object") {
    throw new SupervisorFailedError(
      `ai.supervisor("${supervisorName}"): intents["${intent}"] is not an agent, workflow, callback, or entry object`,
      { context: { authoring: true, intent } },
    );
  }

  // Detect mixed-dispatch entries up front. Two of `{ agent, workflow,
  // run }` together is dev confusion, not a feature.
  assertSingleDispatchField(intent, value, supervisorName);

  // (d.run) Run-entry — `{ run, description?, input?, output? }`.
  if ("run" in value && typeof (value as IntentRunEntry).run === "function") {
    const entry = value as IntentRunEntry;

    return {
      intent,
      type: "callback",
      callback: entry.run,
      description: entry.description,
      input: entry.input,
      placeholders: entry.placeholders,
      output: entry.output,
      next: entry.next,
    };
  }

  // (d.agent / a / b) Agent-entry or bare unit. The existing
  // `IntentEntry` shape uses `agent: AgentContract | WorkflowInstance`
  // for both agent and workflow object entries; the resolver still
  // dispatches the underlying unit kind correctly.
  const entryForm = asAgentEntryForm(value);
  const unit = entryForm
    ? entryForm.agent
    : (value as AgentContract<unknown> | WorkflowInstance<unknown, unknown>);

  if (!isDispatchableUnit(unit)) {
    throw new SupervisorFailedError(
      `ai.supervisor("${supervisorName}"): intents["${intent}"] must be an AgentContract, WorkflowInstance, callback, or entry object`,
      { context: { authoring: true, intent } },
    );
  }

  const detectedType = detectType(unit);
  const description = resolveAgentLikeDescription(intent, entryForm, unit, supervisorName);

  if (detectedType === "workflow") {
    if (entryForm?.mode === "stream") {
      throw new SupervisorFailedError(
        `ai.supervisor("${supervisorName}"): intents["${intent}"] sets \`mode: "stream"\` on a workflow entry — stream mode is agent-only in v1. Wrap the workflow in an agent or remove the \`mode\` field.`,
        { context: { authoring: true, intent } },
        "SUPERVISOR_INTENT_STREAM_ON_WORKFLOW",
      );
    }

    return {
      intent,
      type: "workflow",
      unit: unit as WorkflowInstance<unknown, unknown>,
      description,
      input: entryForm?.input,
      placeholders: entryForm?.placeholders,
      output: entryForm?.output,
      next: entryForm?.next,
      history: entryForm?.history,
    };
  }

  assertStreamModeShape(intent, entryForm, supervisorName);

  return {
    intent,
    type: "agent",
    unit: unit as AgentContract<unknown>,
    description,
    input: entryForm?.input,
    placeholders: entryForm?.placeholders,
    output: entryForm?.output,
    next: entryForm?.next,
    history: entryForm?.history,
    mode: entryForm?.mode,
    streamTo: entryForm?.streamTo,
  };
}

/**
 * Phase 5 / decisions §34 — enforce the two stream-mode invariants at
 * construction time:
 *
 * 1. `mode: "stream"` and per-intent `output` are mutually exclusive.
 *    Stream agents declare their state contribution via `streamTo`,
 *    not via a schema; allowing both would silently pick one and
 *    surprise the author.
 * 2. `streamTo` is required when `mode === "stream"`. A stream agent
 *    that doesn't write somewhere is a black box — fail loud at the
 *    factory rather than at run-time when state validation surfaces a
 *    missing key.
 */
function assertStreamModeShape(
  intent: string,
  entryForm: IntentEntry | undefined,
  supervisorName: string,
): void {
  if (!entryForm || entryForm.mode !== "stream") {
    return;
  }

  if (entryForm.output) {
    throw new SupervisorFailedError(
      `ai.supervisor("${supervisorName}"): intents["${intent}"] sets both \`mode: "stream"\` and \`output\` — stream mode declares its slice via \`streamTo\`, not a schema. Drop one.`,
      { context: { authoring: true, intent } },
      "SUPERVISOR_INTENT_STREAM_AND_OUTPUT",
    );
  }

  if (typeof entryForm.streamTo !== "string" || entryForm.streamTo.trim().length === 0) {
    throw new SupervisorFailedError(
      `ai.supervisor("${supervisorName}"): intents["${intent}"] sets \`mode: "stream"\` without a non-empty \`streamTo\` — a stream agent must name the state key its assembled prose writes into.`,
      { context: { authoring: true, intent } },
      "SUPERVISOR_INTENT_STREAM_TO_REQUIRED",
    );
  }
}

/**
 * Reject entries that mix dispatch fields. `{ agent, run }` is a
 * common copy-paste bug; we surface it at construction with a clear
 * message rather than silently picking one based on resolution
 * order.
 */
function assertSingleDispatchField(intent: string, value: object, supervisorName: string): void {
  const dispatchKeys = (["run", "agent", "workflow"] as const).filter((key) => key in value);

  if (dispatchKeys.length > 1) {
    throw new SupervisorFailedError(
      `ai.supervisor("${supervisorName}"): intents["${intent}"] has multiple dispatch fields (${dispatchKeys
        .map((key) => `\`${key}\``)
        .join(
          ", ",
        )}) — pick one. Two dispatch fields on the same entry is dev confusion, not a feature.`,
      { context: { authoring: true, intent } },
      "SUPERVISOR_INTENT_MIXED_DISPATCH",
    );
  }
}

/**
 * Coerce a `SupervisorIntentValue` into the agent-flavored
 * `IntentEntry` form when the caller passed the object form. Returns
 * `undefined` for bare shorthand. The shape check keys on the
 * presence of an `agent` property because both `AgentContract` and
 * `WorkflowInstance` have their own identifying fields
 * (`isAnonymous` for agents, `signature` for workflows) but neither
 * carries a top-level `agent`.
 */
function asAgentEntryForm(value: object): IntentEntry | undefined {
  if (!("agent" in value)) {
    return undefined;
  }

  const candidate = (value as { agent: unknown }).agent;

  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }

  return value as IntentEntry;
}

function isDispatchableUnit(
  value: unknown,
): value is AgentContract<unknown> | WorkflowInstance<unknown, unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { name?: unknown; execute?: unknown };

  return typeof candidate.name === "string" && typeof candidate.execute === "function";
}

function detectType(
  unit: AgentContract<unknown> | WorkflowInstance<unknown, unknown>,
): "agent" | "workflow" {
  // Workflows expose a structural `signature` field; agents don't.
  if (typeof (unit as WorkflowInstance<unknown, unknown>).signature === "string") {
    return "workflow";
  }

  return "agent";
}

function resolveAgentLikeDescription(
  intent: string,
  entryForm: IntentEntry | undefined,
  unit: AgentContract<unknown> | WorkflowInstance<unknown, unknown>,
  supervisorName: string,
): string {
  const entryOverride = entryForm?.description;

  if (entryOverride && entryOverride.trim().length > 0) {
    return entryOverride;
  }

  const unitDescription = (unit as { description?: unknown }).description;

  if (typeof unitDescription === "string" && unitDescription.trim().length > 0) {
    return unitDescription;
  }

  // Empty string sentinel — caller (assertRouterDescriptions) decides
  // whether a missing description is fatal. Under deterministic
  // `route` mode it isn't.
  return "";
}

/**
 * Type guard helper for downstream modules. Narrows a raw
 * `AgentResult | WorkflowResult` based on the resolved entry's kind,
 * so transformers and emitters can pull the right fields without
 * re-checking shape.
 */
export function isAgentResult(raw: DispatchRawResult): raw is AgentResult<unknown> {
  return raw.type === "agent";
}

export function isWorkflowResult(raw: DispatchRawResult): raw is WorkflowResult<unknown> {
  return raw.type === "workflow";
}
