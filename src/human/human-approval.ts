import type { AgentMiddleware } from "../contracts/middleware/middleware.contract";
import type { MiddlewareToolContext } from "../contracts/middleware/middleware-context.type";
import type { BaseReport } from "../contracts/result/base-report.type";
import type { Usage } from "../contracts/result/usage.type";
import type { AIError } from "../errors/ai-error";
import type { ToolInvokeResult } from "../tool/tool";
import { generateRunId } from "../utils/generate-run-id";
import type {
  ApprovalDecision,
  ApprovalRequest,
  HumanApprovalOptions,
  PolicyContext,
} from "./contracts";
import { ApprovalRejectedError, InterruptSuspendedError } from "./errors";
import { evaluatePolicy } from "./policy";
import { takeSeededDecision } from "./resume-seed";

/** Default middleware name when {@link HumanApprovalOptions.name} is omitted. */
const DEFAULT_NAME = "human-approval";

/** Zero usage for a synthetic, no-LLM-spend short-circuit result. */
const ZERO_USAGE: Usage = Object.freeze({ input: 0, output: 0, total: 0 });

/**
 * Mutable view of {@link MiddlewareToolContext.request} used only to
 * apply an `edit` decision. The context types `request.input` as
 * `readonly`, but the agent dispatch reads `request.input` (the SAME
 * object) when it invokes the real tool *after* the `tool.before`
 * pipeline returns — so reassigning it here is how an edited-args
 * decision reaches the tool. This narrow local type makes that one
 * deliberate write explicit instead of casting away the whole context.
 */
interface MutableToolRequest {
  input: unknown;
}

/**
 * Derive the read-only {@link PolicyContext} the policy + request are
 * built from out of the wrapping {@link MiddlewareToolContext}.
 */
function toPolicyContext(ctx: MiddlewareToolContext): PolicyContext {
  return {
    toolName: ctx.tool.name,
    toolDescription: ctx.tool.description,
    args: ctx.request.input,
    agentName: ctx.agent.name,
    tripIndex: ctx.tripIndex,
    sessionId: ctx.options?.sessionId,
  };
}

/**
 * Generate a stable, unique id for a pending interrupt. Shaped
 * `${agentName}.${sessionId ?? "nosession"}.${tripIndex}.${random}` so a
 * reviewer can eyeball the originating run, while the trailing random
 * segment guarantees per-call uniqueness even within one trip.
 */
function makeInterruptId(ctx: MiddlewareToolContext): string {
  const session = ctx.options?.sessionId ?? "nosession";
  const random = generateRunId("interrupt");

  return `${ctx.agent.name}.${session}.${ctx.tripIndex}.${random}`;
}

/**
 * Build the {@link ApprovalRequest} a human rules on, from the tool
 * context and the policy-derived tags.
 */
function buildRequest(
  ctx: MiddlewareToolContext,
  interruptId: string,
  tags: string[] | undefined,
): ApprovalRequest {
  return {
    interruptId,
    toolName: ctx.tool.name,
    toolDescription: ctx.tool.description,
    args: ctx.request.input,
    context: {
      agentName: ctx.agent.name,
      tripIndex: ctx.tripIndex,
      sessionId: ctx.options?.sessionId,
      originalInput: ctx.input,
      ...(tags ? { tags } : {}),
    },
    requestedAt: new Date().toISOString(),
  };
}

/**
 * Synthesize a failed {@link ToolInvokeResult} carrying a typed error.
 *
 * The approval middleware returns this from `tool.before` to
 * **short-circuit** the real tool without throwing: the pipeline treats a
 * defined return as the tool's result, the agent records a failed
 * `ToolCall`, and the model sees `{ error }` on the next trip — exactly
 * the existing tool-error feedback path. Used for both `reject`
 * (`ApprovalRejectedError`) and durable suspend (`InterruptSuspendedError`).
 */
function failedResult(error: AIError, toolName: string): ToolInvokeResult<unknown> {
  const runId = generateRunId("tool");
  const nowIso = new Date().toISOString();

  const report: BaseReport = {
    runId,
    rootRunId: runId,
    name: toolName,
    type: "tool",
    status: "failed",
    startedAt: nowIso,
    endedAt: nowIso,
    duration: 0,
    usage: ZERO_USAGE,
    children: [],
  };

  return { error, usage: ZERO_USAGE, report };
}

/**
 * Human-in-the-loop approval gate for an agent's tool calls — the
 * middleware behind `ai.human.approval(options)`.
 *
 * **Role.** Pauses *before a specific tool call* and routes it to a human
 * who can **approve** (run the real tool unchanged), **reject** (the model
 * sees a typed error and self-corrects), or **edit** (run the tool with
 * reviewer-replaced args). The dangerous subset is chosen by an
 * {@link import("./contracts").InterruptPolicy} (allowlist / denylist /
 * predicate); every other call passes through untouched.
 *
 * **One hook.** Declares only `tool.before`. On each tool dispatch it:
 * 1. evaluates the policy — not gated → returns `void`, the real tool runs;
 * 2. for a gated call, builds an {@link ApprovalRequest} and calls the
 *    {@link import("./contracts").ApprovalHandler};
 * 3. applies the returned {@link ApprovalDecision}:
 *    - `approve` → returns `void`, the real tool runs;
 *    - `reject` → short-circuits a failed `ToolInvokeResult` carrying an
 *      {@link ApprovalRejectedError} (the reviewer's `reason` reaches the
 *      model);
 *    - `edit` → rewrites `ctx.request.input` to the reviewer's args and
 *      returns `void`, so the real tool runs with the edited args (schema
 *      validation still applies — bad edits surface as a tool error).
 *
 * **Durable mode.** When a `store` is configured and the handler throws
 * {@link InterruptSuspendedError} (after persisting the interrupt
 * out-of-band), the middleware catches its **own** sentinel and
 * short-circuits a failed result carrying it — so the caller reads
 * `result.error.interruptId` and later calls
 * `ai.human.resume(interruptId, decision)`. The middleware **never throws
 * out of the pipeline**: every outcome (skip, approve, reject, edit,
 * suspend) returns normally; only a *handler bug* (a non-sentinel throw)
 * propagates, and even then the agent dispatch funnels it onto
 * `result.error` — `execute()` still never throws.
 *
 * @param options - Policy, handler, optional durable store, optional name.
 * @returns An {@link AgentMiddleware} declaring a single `tool.before` hook.
 *
 * @example
 * const support = ai.agent({
 *   model,
 *   tools: [refundCustomer],
 *   middleware: [
 *     humanApproval({
 *       policy: { type: "allowlist", tools: ["refundCustomer"], tags: () => ["money"] },
 *       handler: async (req) => ui.prompt(req), // { type: "edit", args: { amount: 5 } }
 *     }),
 *   ],
 * });
 */
export function humanApproval(options: HumanApprovalOptions): AgentMiddleware {
  const name = options.name ?? DEFAULT_NAME;
  const { policy, handler } = options;

  return {
    name,
    tool: {
      async before(
        ctx: MiddlewareToolContext,
      ): Promise<ToolInvokeResult<unknown> | void> {
        const verdict = evaluatePolicy(policy, toPolicyContext(ctx));

        // Not gated — let the real tool run unchanged.
        if (!verdict.requiresApproval) {
          return;
        }

        const interruptId = makeInterruptId(ctx);
        const request = buildRequest(ctx, interruptId, verdict.tags);

        // Durable resume: `ai.human.resume(...)` re-runs this same agent
        // with the human's decision pre-seeded (keyed by agent name). On a
        // hit we replay the seeded decision exactly once and skip the
        // author's handler entirely — the gated call resolves to the
        // ruling instead of pausing again.
        const seeded = takeSeededDecision(ctx.agent.name);

        let decision: ApprovalDecision;

        if (seeded !== undefined) {
          decision = seeded;
        } else {
          try {
            decision = await handler(request);
          } catch (thrown) {
            // A durable handler signals suspension by throwing our OWN
            // sentinel after persisting the interrupt. Recognize it and
            // short-circuit a failed result carrying it — the caller reads
            // `error.interruptId` and resumes later. Any OTHER throw is a
            // handler bug; re-throw so the agent dispatch funnels it onto
            // `result.error` (we never swallow a bug into silent approval).
            if (thrown instanceof InterruptSuspendedError) {
              return failedResult(thrown, ctx.tool.name);
            }

            throw thrown;
          }
        }

        if (decision.type === "approve") {
          // Run the real tool with the model's original args.
          return;
        }

        if (decision.type === "reject") {
          const error = new ApprovalRejectedError(
            `Tool call "${ctx.tool.name}" rejected by reviewer — ${decision.reason}`,
            { reason: decision.reason, toolName: ctx.tool.name },
          );

          return failedResult(error, ctx.tool.name);
        }

        // `edit` — rewrite the pending args, then let the real tool run.
        // The agent dispatch reads `request.input` (this same object) when
        // it invokes the tool after this hook returns, so the reassignment
        // takes effect. Bad edits still fail the tool's own schema check.
        (ctx.request as unknown as MutableToolRequest).input = decision.args;

        return;
      },
    },
  };
}
