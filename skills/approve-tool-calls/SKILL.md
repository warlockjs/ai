---
name: approve-tool-calls
description: 'Gate an agent''s tool calls behind a human with `ai.human.approval(options)` (the `tool.before` approval-gate middleware) — ships in @warlock.js/ai core. Triggers: `ai.human.approval`, `humanApproval`, `HumanApprovalOptions`, `ApprovalRequest`, `ApprovalDecision`, `ApprovalHandler`, `InterruptPolicy`, `evaluatePolicy`, `ApprovalRejectedError`, `policy: { type: "allowlist" | "denylist" | "predicate" }`, decision `{ type: "approve" | "reject" | "edit" }`; ''human in the loop'', ''approve a tool call before it runs'', ''ask a human before the agent sends/charges/deletes'', ''pause before a dangerous tool'', ''let an operator edit the tool args'', ''reject a tool call with a reason the model can self-correct from''. Typical import `import { ai } from "@warlock.js/ai"`. Skip: persisting the request and resuming hours later out-of-process — `@warlock.js/ai/durable-resume/SKILL.md`; the agent/middleware/tool primitives themselves — `@warlock.js/ai`.'
---

# Approve tool calls — the human-in-the-loop gate

`ai.human.approval(options)` returns an `AgentMiddleware` with **one** hook — `tool.before` — that pauses *before a specific tool call* and routes it to a human. The human can **approve** (run the real tool unchanged), **reject** (the model sees a typed error and self-corrects), or **edit** (run the tool with replaced args). Every call the policy doesn't gate passes through untouched.

`ai.human.*` ships natively on the shared `ai` object from `@warlock.js/ai` core — no extra import or registration step. The named `humanApproval` export is the same factory.

```ts
import { ai } from "@warlock.js/ai";
import { OpenAISDK } from "@warlock.js/ai-openai";

const openai = new OpenAISDK({ apiKey: process.env.OPENAI_API_KEY! });

const support = ai.agent({
  model: openai.model({ name: "gpt-4o" }),
  tools: [refundCustomer, lookupOrder],
  middleware: [
    ai.human.approval({
      policy: { type: "allowlist", tools: ["refundCustomer"], tags: () => ["money"] },
      // SSE / CLI handler resolves when the operator rules:
      handler: async (req) => ui.prompt(req), // → { type: "approve" } | { type: "reject", reason } | { type: "edit", args }
    }),
  ],
});

await support.execute("Refund order #4821"); // pauses at refundCustomer, awaits the operator
```

## The three decisions

A handler turns an `ApprovalRequest` into an `ApprovalDecision` — a union discriminated by `type` (never `kind`):

| `decision.type` | Effect | What the model sees next |
|---|---|---|
| `"approve"` | The real tool runs with the model's original args. | The tool's normal result. |
| `"reject"` | Short-circuits an `ApprovalRejectedError` carrying `reason`. | `{ error }` on the next trip — it can self-correct. |
| `"edit"` | The reviewer's `args` replace the model's; the real tool then runs. | The tool's result for the edited args. |

```ts
type ApprovalDecision =
  | { type: "approve" }
  | { type: "reject"; reason: string }
  | { type: "edit"; args: unknown; reason?: string };
```

An `edit` still goes through the tool's own Standard-Schema validation — if the replaced args don't fit the schema, the tool surfaces a validation error on `result.error` and the model self-corrects. No special-casing.

## The interrupt policy — which calls need a human

`policy` decides *which* tool calls are gated. It's a union keyed on `type`:

| `policy.type` | Gates a call when… | Tags |
|---|---|---|
| `"allowlist"` | the tool name **is** in `tools`. | optional `tags(toolName)` callback |
| `"denylist"` | the tool name is **not** in `tools` (gate everything else). | optional `tags(toolName)` callback |
| `"predicate"` | `requiresApproval(ctx)` returns a truthy value. | a returned `string[]` doubles as the tags |

```ts
// Allowlist — only refunds need sign-off:
{ type: "allowlist", tools: ["refundCustomer"], tags: () => ["money"] }

// Denylist — everything except read-only lookups needs sign-off:
{ type: "denylist", tools: ["lookupOrder", "searchCatalog"] }

// Predicate — args-aware: only large refunds, tagged for the reviewer UI:
{
  type: "predicate",
  requiresApproval: (ctx) =>
    ctx.toolName === "refundCustomer" && (ctx.args as { amount: number }).amount > 100
      ? ["money", "high-value"]
      : false,
}
```

The predicate sees a read-only `PolicyContext` — `toolName`, `toolDescription`, `args` (the model's exact input), `agentName`, `tripIndex`, `sessionId`. Return `false` (or an empty array) to skip approval; `true` or a non-empty `string[]` to require it. The `string[]` becomes `request.context.tags`, surfaced verbatim to the reviewer so a UI can group or prioritize.

Compose with `forTool(names, mw)` from `@warlock.js/ai` for static, name-based scoping and let `policy` be the dynamic, args-aware layer on top.

`evaluatePolicy(policy, context)` is the exported, pure core if you want to reuse the gate decision outside the middleware (it never throws, does no IO, and returns `{ requiresApproval, tags? }`).

## The request a reviewer rules on

For a gated call the middleware builds an `ApprovalRequest` and hands it to your `handler`:

```ts
interface ApprovalRequest {
  interruptId: string;          // stable id; durable mode keys the store on it
  toolName: string;
  toolDescription?: string;
  args: unknown;                // the model's exact args
  context: {
    agentName: string;
    tripIndex: number;
    sessionId?: string;
    originalInput?: string;     // the run's prompt (used by durable re-run)
    tags?: string[];            // from the policy match
  };
  requestedAt: string;          // ISO-8601
}
```

The handler runs in one of two modes that share this one signature:

- **interactive** — return the decision (or a promise of it); the hook `await`s it in-process. The whole agent run stays on the stack — no store needed. This skill.
- **durable** — persist the request and `throw` to suspend, resuming from another process later. See [`durable-resume/SKILL.md`](@warlock.js/ai/durable-resume/SKILL.md).

## It never throws out of the pipeline

The middleware is a harness, not a detector — every outcome (skip, approve, reject, edit) returns normally. A `reject` does **not** throw out of `execute()`: it short-circuits a failed `ToolInvokeResult` carrying an `ApprovalRejectedError`, so the error rides `result.error` like every other `AIError` and `agent.execute()` still never throws.

```ts
const result = await support.execute("Refund order #4821");

if (result.error instanceof ApprovalRejectedError) {
  logAudit(`${result.error.toolName} rejected: ${result.error.reason}`);
}
```

Only a *handler bug* — a non-sentinel throw from your handler — propagates, and even then the agent dispatch funnels it onto `result.error` rather than crashing the run. The gate never swallows a bug into a silent approval.

## Edge cases

- **Duplicate middleware name.** Middleware names are validated unique per agent. The default name is `"human-approval"`, so two approval middlewares on one agent need distinct `name`s.
- **Silent tools.** A `silent`-mode tool's result isn't fed back to the model, but approval still runs (we gate *before* dispatch). A `reject` on a silent tool writes a tool message that's harmless but unread.
- **Abort during an interactive await.** `ctx.signal` is in scope; honor it in a long-running handler so a cancelled run rejects rather than hanging.

## See also

- [`@warlock.js/ai/durable-resume/SKILL.md`](@warlock.js/ai/durable-resume/SKILL.md) — persist the request, resume out-of-process hours later via `ai.human.resume(...)` and the `InterruptStore`.
- `@warlock.js/ai` — the `ai.agent(...)`, `AgentMiddleware`, `tool.before`, and `ToolInvokeResult` primitives this gate wraps.
