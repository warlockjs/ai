import type { Message } from "../contracts/conversation-message.type";
import type {
  OrchestratorAsToolOptions,
  OrchestratorContract,
} from "../contracts/orchestrator/orchestrator.contract";
import type { SupervisorInput } from "../contracts/supervisor/supervisor-input.type";
import { SupervisorFailedError } from "../errors";
import { compositeAsTool, type ToolContract } from "../tool/tool";
import { generateRunId } from "../utils/generate-run-id";

/**
 * Shape the orchestrator looks for inside the validated tool input when
 * `sessionScope: "shared"` — the parent must thread the session id (and
 * optionally the prior history) through the tool's `inputSchema`
 * payload, since the boundary is opaque (§13). Everything else on the
 * payload becomes the orchestrator's `execute(input)` argument.
 */
type SharedScopePayload = {
  sessionId?: unknown;
  history?: unknown;
  [key: string]: unknown;
};

/**
 * Wrap an {@link OrchestratorContract} as a {@link ToolContract} so an
 * outer agent can invoke it from its tool-call loop (design §13).
 * Mirrors `supervisor.asTool()` — same `compositeAsTool` composition and
 * error normalization — and adds `sessionScope`.
 *
 * The boundary is OPAQUE (§13, §18.6): the parent's `signal` / `context`
 * / events do NOT auto-forward. Anything the wrapped orchestrator needs
 * per call must ride on the tool's `inputSchema` payload.
 *
 * Session continuity:
 * - `"fresh"` (default) — each invocation gets a brand-new `sessionId`
 *   (a generated id) and empty history; the session lives only for this
 *   tool call. The whole validated payload is forwarded as the
 *   orchestrator's `execute(input)` argument.
 * - `"shared"` — the parent supplies `sessionId` (and optionally
 *   `history`) inside the validated payload; the orchestrator
 *   participates in that session. The remaining payload fields are
 *   forwarded as `execute(input)`. A missing/blank `sessionId` throws
 *   {@link SupervisorFailedError}.
 *
 * On `result.error`, the typed orchestrator error is thrown so the tool
 * wrapper produces a `ToolExecutionError` with `cause` preserved — the
 * outer agent sees one uniform error class.
 *
 * @example
 * const support = ai.orchestrator({ name: "refund-support", intents });
 * const supportTool = support.asTool({
 *   name: "handle_refund",
 *   description: "Handle a refund conversation end-to-end.",
 *   inputSchema: v.object({ message: v.string() }),
 * });
 * const concierge = ai.agent({ model, tools: [supportTool] });
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

  return compositeAsTool<TToolInput, TOutput>({
    name: options.name ?? orchestrator.name,
    description:
      options.description ??
      `Invoke orchestrator "${orchestrator.name}" as a tool.`,
    input: options.inputSchema,
    execute: async (input) => {
      const { sessionId, history, executeInput } = resolveSession(
        sessionScope,
        input,
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
 * argument from the validated tool payload, according to `sessionScope`.
 */
function resolveSession(
  sessionScope: "fresh" | "shared",
  input: unknown,
): { sessionId: string; history: Message[]; executeInput: SupervisorInput } {
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

  if (typeof payload.sessionId !== "string" || payload.sessionId.length === 0) {
    throw new SupervisorFailedError(
      'orchestrator.asTool(): sessionScope "shared" requires a `sessionId` string in the tool input payload',
    );
  }

  const { sessionId, history, ...rest } = payload;

  return {
    sessionId,
    history: Array.isArray(history) ? (history as Message[]) : [],
    executeInput: coerceInput(rest),
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
