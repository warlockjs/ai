import type { Message } from "../contracts/conversation-message.type";
import type {
  OrchestratorAsToolOptions,
  OrchestratorContract,
  OrchestratorToolSession,
} from "../contracts/orchestrator/orchestrator.contract";
import type { SupervisorInput } from "../contracts/supervisor/supervisor-input.type";
import type { ToolContext } from "../contracts/tool.contract";
import { SupervisorFailedError } from "../errors";
import { compositeAsTool, type ToolContract } from "../tool/tool";
import { generateRunId } from "../utils/generate-run-id";

/**
 * Shape read out of the validated tool input ONLY under the
 * `unsafeAllowModelSessionId` opt-in — the legacy, model-chosen session
 * path. Everything else on the payload becomes the orchestrator's
 * `execute(input)` argument.
 */
type SharedScopePayload = {
  sessionId?: unknown;
  history?: unknown;
  [key: string]: unknown;
};

/** Resolved per-call session binding for one tool invocation. */
type ResolvedToolSession = {
  sessionId: string;
  history: Message[];
  executeInput: SupervisorInput;
};

/**
 * Wrap an {@link OrchestratorContract} as a {@link ToolContract} so an
 * outer agent can invoke it from its tool-call loop (design §13).
 * Mirrors `supervisor.asTool()` — same `compositeAsTool` composition and
 * error normalization — and adds `sessionScope`.
 *
 * The boundary is OPAQUE (§13, §18.6): the parent's `context` / events do
 * NOT auto-forward. Per-call data the wrapped orchestrator needs rides on
 * the tool's `inputSchema` payload — with ONE deliberate exception, the
 * session binding below, because the payload is written by an LLM.
 *
 * Session continuity:
 * - `"fresh"` (default) — each invocation gets a brand-new `sessionId`
 *   (a generated id) and empty history; the session lives only for this
 *   tool call. The whole validated payload is forwarded as the
 *   orchestrator's `execute(input)` argument.
 * - `"shared"` — the orchestrator joins an EXISTING session named by the
 *   developer through `options.session`: either a literal id fixed at
 *   construction, or a resolver that reads the invocation's
 *   {@link ToolContext} (`ctx.artifacts`, the out-of-band bag the model
 *   cannot write to). The whole validated payload is forwarded as
 *   `execute(input)`. A `"shared"` tool built without `session` throws at
 *   construction.
 *
 * **Why the session id is not a schema field (4.15.0 security fix).**
 * Before this release, `"shared"` scope read `sessionId` straight out of
 * the model-generated tool arguments. A `sessionId` is bearer-equivalent
 * — naming one grants read/write on that session's persisted state — so
 * any prompt injection reaching the outer agent ("continue session
 * `<victim-id>`") made the nested orchestrator load a stranger's
 * conversation, mutate it, and echo its content back into the attacker's
 * transcript. The binding now lives on channels the model has no access
 * to. The old behavior survives only behind the loudly-named
 * `unsafeAllowModelSessionId` opt-in.
 *
 * On `result.error`, the typed orchestrator error is thrown so the tool
 * wrapper produces a `ToolExecutionError` with `cause` preserved — the
 * outer agent sees one uniform error class.
 *
 * @example
 * const support = ai.orchestrator({ name: "refund-support", intents });
 *
 * // Fresh session per call — no continuity, nothing to hijack.
 * const supportTool = support.asTool({
 *   name: "handle_refund",
 *   description: "Handle a refund conversation end-to-end.",
 *   inputSchema: v.object({ message: v.string() }),
 * });
 *
 * // Continuous session — bound from the authenticated request, never
 * // from the model's arguments.
 * const continuousTool = support.asTool({
 *   name: "handle_refund",
 *   inputSchema: v.object({ message: v.string() }),
 *   sessionScope: "shared",
 *   session: (ctx) => ({
 *     sessionId: String(ctx?.artifacts?.refundSessionId ?? ""),
 *   }),
 * });
 */
export function asTool<TOutput, TState, TToolInput>(
  orchestrator: OrchestratorContract<TOutput, TState>,
  options: OrchestratorAsToolOptions<TToolInput>,
): ToolContract<TToolInput, TOutput> {
  if (!orchestrator.name || typeof orchestrator.name !== "string") {
    throw new SupervisorFailedError(
      "orchestrator.asTool(): orchestrator must have a `name` to be wrapped as a tool",
    );
  }

  const sessionScope = options.sessionScope ?? "fresh";
  const allowModelSessionId = options.unsafeAllowModelSessionId === true;

  // Fail closed at construction, not at the first hostile tool call: a
  // "shared" tool with no developer-supplied binding would have to fall
  // back to the model's payload, which is exactly the hijack path.
  if (sessionScope === "shared" && !options.session && !allowModelSessionId) {
    throw new SupervisorFailedError(
      'orchestrator.asTool(): sessionScope "shared" requires a `session` binding — ' +
        "a session id fixed at construction, or a `(ctx) => sessionId` resolver reading the " +
        "tool context. A model-supplied `sessionId` in the tool payload is bearer-equivalent " +
        "access to that session; pass `unsafeAllowModelSessionId: true` only if the outer " +
        "agent's context is trusted and you verify session ownership yourself",
    );
  }

  return compositeAsTool<TToolInput, TOutput>({
    name: options.name ?? orchestrator.name,
    description:
      options.description ??
      `Invoke orchestrator "${orchestrator.name}" as a tool.`,
    input: options.inputSchema,
    execute: async (input, ctx) => {
      const { sessionId, history, executeInput } = await resolveSession(
        sessionScope,
        input,
        ctx,
        options.session,
        allowModelSessionId,
      );

      const result = await orchestrator.execute(executeInput, {
        sessionId,
        history,
      });

      if (result.error) {
        // Surface the typed orchestrator error — the outer ToolContract
        // wraps it as a ToolExecutionError with `cause` preserved.
        throw result.error;
      }

      return {
        data: result.data as TOutput,
        usage: result.usage,
        report: result.report,
      };
    },
  });
}

/**
 * Resolve the per-call `sessionId`, `history`, and the `execute(input)`
 * argument, according to `sessionScope`.
 *
 * For `"shared"` scope the session comes from the developer's `session`
 * binding (construction-time literal or `ToolContext` resolver) — the
 * validated payload is never consulted for it unless the caller opted
 * into `unsafeAllowModelSessionId`. Either way `sessionId` / `history`
 * are stripped from the payload before it is forwarded as
 * `execute(input)`, so a model-authored field of that name can't reach
 * the orchestrator's input under a misleading name.
 */
async function resolveSession(
  sessionScope: "fresh" | "shared",
  input: unknown,
  ctx: ToolContext | undefined,
  session: OrchestratorToolSession | undefined,
  allowModelSessionId: boolean,
): Promise<ResolvedToolSession> {
  if (sessionScope === "fresh") {
    return {
      sessionId: generateRunId("session"),
      history: [],
      executeInput: coerceInput(input),
    };
  }

  const payload = (
    typeof input === "object" && input !== null ? input : {}
  ) as SharedScopePayload;

  const { sessionId: payloadSessionId, history: payloadHistory, ...rest } = payload;
  const executeInput = coerceInput(rest);

  if (session !== undefined) {
    const bound = typeof session === "function" ? await session(ctx) : session;

    const sessionId = typeof bound === "string" ? bound : bound?.sessionId;
    const history = typeof bound === "string" ? undefined : bound?.history;

    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new SupervisorFailedError(
        'orchestrator.asTool(): the `session` binding for sessionScope "shared" resolved to no ' +
          "session id — return a non-empty string (or `{ sessionId }`) from it, or throw to " +
          "reject the call. The model's payload is never used as a fallback",
      );
    }

    return {
      sessionId,
      history: Array.isArray(history) ? history : [],
      executeInput,
    };
  }

  // Legacy, explicitly opted-in path: the session id is whatever the
  // calling model wrote. Anything that can influence that model chooses
  // the session — see `unsafeAllowModelSessionId`.
  if (!allowModelSessionId) {
    throw new SupervisorFailedError(
      'orchestrator.asTool(): sessionScope "shared" requires a `session` binding',
    );
  }

  if (typeof payloadSessionId !== "string" || payloadSessionId.length === 0) {
    throw new SupervisorFailedError(
      'orchestrator.asTool(): sessionScope "shared" requires a `sessionId` string in the tool input payload',
    );
  }

  return {
    sessionId: payloadSessionId,
    history: Array.isArray(payloadHistory) ? (payloadHistory as Message[]) : [],
    executeInput,
  };
}

/**
 * Coerce a tool-input value into the `SupervisorInput` shape the
 * orchestrator's `execute()` accepts (`string | Record<string,
 * unknown>`). Strings and plain objects pass through; everything else
 * is JSON-stringified so the orchestrator receives a predictable input
 * regardless of how the outer agent shaped its call.
 */
function coerceInput(value: unknown): SupervisorInput {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }

  if (value === undefined || value === null) {
    return "";
  }

  return String(value);
}
