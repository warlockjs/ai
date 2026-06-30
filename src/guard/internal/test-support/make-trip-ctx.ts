import type {
  MiddlewareToolContext,
  MiddlewareTripContext,
} from "../../../contracts/middleware/middleware-context.type";

/**
 * Test-only fixtures that build a {@link MiddlewareTripContext} /
 * {@link MiddlewareToolContext} without spinning up a real agent run.
 *
 * The guard middleware reads only a handful of context fields — `messages`
 * (input phase), `state` (flag recording), and `request.input` (tool phase) —
 * so these fixtures populate exactly those plus stub identity fields, and the
 * unused remainder is satisfied structurally. Not shipped (lives under
 * `internal/test-support`); imported only by `*.spec.ts`.
 */

/** Options for {@link makeTripCtx}. */
export interface MakeTripCtxOptions {
  /** The user prompt the input detectors should inspect. Default `""`. */
  prompt?: string;
  /** A pre-seeded shared-state bag. Default a fresh `Map`. */
  state?: Map<string, unknown>;
}

/**
 * Build a minimal {@link MiddlewareTripContext} carrying a single user message
 * (so `extractUserText` returns `prompt`) and a shared-state bag.
 */
export function makeTripCtx(
  options: MakeTripCtxOptions = {},
): MiddlewareTripContext {
  const state = options.state ?? new Map<string, unknown>();
  const prompt = options.prompt ?? "";

  return {
    agent: { name: "test-agent", isAnonymous: false },
    model: { name: "test-model", provider: "test" },
    input: prompt,
    options: undefined,
    state,
    tripIndex: 0,
    messages: [{ role: "user", content: prompt }],
  } satisfies MiddlewareTripContext;
}

/** Options for {@link makeToolCtx}. */
export interface MakeToolCtxOptions {
  /** The tool name being dispatched. Default `"test_tool"`. */
  toolName?: string;
  /** The args the model produced for the tool (becomes `request.input`). */
  input?: unknown;
  /** A pre-seeded shared-state bag. Default a fresh `Map`. */
  state?: Map<string, unknown>;
}

/**
 * Build a minimal {@link MiddlewareToolContext} carrying a fake
 * {@link ModelToolCallRequest} (`request.input` is what the tool detectors
 * stringify) and the dispatched tool's name.
 */
export function makeToolCtx(
  options: MakeToolCtxOptions = {},
): MiddlewareToolContext {
  const state = options.state ?? new Map<string, unknown>();
  const toolName = options.toolName ?? "test_tool";

  return {
    agent: { name: "test-agent", isAnonymous: false },
    model: { name: "test-model", provider: "test" },
    input: "",
    options: undefined,
    state,
    tripIndex: 0,
    messages: [],
    tool: { name: toolName },
    request: { id: "call_test", name: toolName, input: options.input },
  } satisfies MiddlewareToolContext;
}
