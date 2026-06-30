/**
 * What a human can do to a gated tool call.
 *
 * The discriminator for the {@link ApprovalDecision} union — `type`,
 * never `kind`. Each member of the union is keyed on one of these
 * literals so a reviewer surface can branch exhaustively.
 *
 * - `"approve"` — let the real tool run with the model's args unchanged.
 * - `"reject"`  — short-circuit the call; the model sees a typed error
 *   (carrying the reviewer's reason) and can self-correct on the next trip.
 * - `"edit"`    — run the tool, but with reviewer-replaced args.
 */
export type ApprovalDecisionType = "approve" | "reject" | "edit";

/**
 * The read-only run context surfaced to a reviewer alongside an
 * {@link ApprovalRequest}. Derived from the wrapping
 * `MiddlewareToolContext` — the reviewer never mutates it.
 */
export interface ApprovalRequestContext {
  /** Name of the agent whose tool call is being gated. */
  agentName: string;

  /** Zero-based index of the model round-trip that produced the call. */
  tripIndex: number;

  /** Originating session id, when the run is part of an orchestrator session. */
  sessionId?: string;

  /**
   * The agent's original input prompt for the run that raised this
   * interrupt. Captured so a durable `ai.human.resume(...)` re-run can
   * re-drive the agent with the same prompt without the caller having to
   * thread it through out-of-band.
   */
  originalInput?: string;

  /**
   * Author-supplied tags from the policy match (e.g. `"destructive"`,
   * `"money"`). Lets a reviewer surface group or prioritize requests
   * without re-deriving the rule that gated the call.
   */
  tags?: string[];
}

/**
 * The pending tool call a human is asked to rule on.
 *
 * Built by the approval middleware from the `MiddlewareToolContext` the
 * moment the {@link InterruptPolicy} gates a call. In durable mode it is
 * also the payload persisted inside a
 * {@link import("./interrupt-store.contract").PendingInterrupt}, keyed by
 * {@link ApprovalRequest.interruptId}.
 */
export interface ApprovalRequest {
  /**
   * Stable id for this pending call. Durable mode keys the
   * `InterruptStore` on it; the caller surfaces it to the reviewer and
   * later passes it to `ai.human.resume(interruptId, decision)`.
   */
  interruptId: string;

  /** Registered name of the tool the model wants to invoke. */
  toolName: string;

  /** Human-facing description from the tool contract, when present. */
  toolDescription?: string;

  /** The exact arguments the model produced for the tool. */
  args: unknown;

  /** Read-only run context the reviewer sees. */
  context: ApprovalRequestContext;

  /** When the request was raised, as an ISO-8601 timestamp. */
  requestedAt: string;
}

/**
 * A human's ruling on an {@link ApprovalRequest}.
 *
 * A discriminated union keyed on `type` (never `kind`):
 * - `approve` — run the real tool unchanged.
 * - `reject`  — short-circuit; `reason` is surfaced to the model via the
 *   typed error so it can self-correct.
 * - `edit`    — run the tool with `args` replaced; `reason` is optional
 *   audit context.
 */
export type ApprovalDecision =
  | { type: "approve" }
  | { type: "reject"; reason: string }
  | { type: "edit"; args: unknown; reason?: string };

/**
 * Turns an {@link ApprovalRequest} into an {@link ApprovalDecision}.
 *
 * Two modes share this one signature:
 * - **interactive** — resolve the returned promise (or return a decision
 *   synchronously) when the operator rules; the middleware `await`s it
 *   in-process.
 * - **durable** — persist a
 *   {@link import("./interrupt-store.contract").PendingInterrupt} to the
 *   configured store, then throw
 *   {@link import("../errors").InterruptSuspendedError} to suspend the
 *   run; a later `ai.human.resume(...)` call replays the decision.
 */
export type ApprovalHandler = (
  request: ApprovalRequest,
) => Promise<ApprovalDecision> | ApprovalDecision;

/**
 * The minimal read-only view a {@link InterruptPolicy} predicate sees,
 * derived from the wrapping `MiddlewareToolContext`. Carries only the
 * fields a gating decision can usefully branch on — the model's args,
 * the tool identity, and the surrounding run identity.
 */
export interface PolicyContext {
  /** Registered name of the tool the model wants to invoke. */
  toolName: string;

  /** Human-facing description from the tool contract, when present. */
  toolDescription?: string;

  /** The exact arguments the model produced for the tool. */
  args: unknown;

  /** Name of the agent whose tool call is being evaluated. */
  agentName: string;

  /** Zero-based index of the model round-trip that produced the call. */
  tripIndex: number;

  /** Originating session id, when part of an orchestrator session. */
  sessionId?: string;
}

/**
 * Decides which tool calls require a human.
 *
 * A discriminated union keyed on `type` (never `kind`):
 * - `allowlist` — gate a call **only** when its tool name is listed.
 * - `denylist`  — gate **every** call **except** the listed tool names.
 * - `predicate` — gate a call when the author-supplied `requiresApproval`
 *   returns a truthy value; a `string[]` both gates the call and supplies
 *   the {@link ApprovalRequestContext.tags}.
 *
 * For the list variants, the optional `tags` callback derives the
 * request tags from the matched tool name.
 */
export type InterruptPolicy =
  | {
      type: "allowlist";
      /** Tool names that require approval. */
      tools: string[];
      /** Derive request tags from the matched tool name. */
      tags?: (toolName: string) => string[];
    }
  | {
      type: "denylist";
      /** Tool names that bypass approval; every other tool is gated. */
      tools: string[];
      /** Derive request tags from the matched tool name. */
      tags?: (toolName: string) => string[];
    }
  | {
      type: "predicate";
      /**
       * Return `false` (or an empty result) to skip approval; return
       * `true` or a `string[]` to require it. A `string[]` doubles as the
       * request {@link ApprovalRequestContext.tags}.
       */
      requiresApproval: (ctx: PolicyContext) => boolean | string[];
    };
