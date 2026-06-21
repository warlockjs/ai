import { describe, expect, it, vi } from "vitest";
import type { Message } from "../contracts/conversation-message.type";
import type {
  OrchestratorContract,
} from "../contracts/orchestrator/orchestrator.contract";
import type { OrchestratorExecuteOptions } from "../contracts/orchestrator/orchestrator-execute-options.type";
import type {
  OrchestratorReport,
  OrchestratorResult,
} from "../contracts/result/orchestrator-result.type";
import type { SupervisorInput } from "../contracts/supervisor/supervisor-input.type";
import { type AIError, SupervisorFailedError } from "../errors";
import { schema } from "../supervisor/_test-helpers";
import { asTool } from "./as-tool";

const noUsage = { input: 0, output: 0, total: 0 };

function makeReport(): OrchestratorReport {
  return {
    runId: "run_1",
    rootRunId: "run_1",
    name: "support",
    type: "orchestrator",
    status: "completed",
    startedAt: "2026-06-18T00:00:00.000Z",
    endedAt: "2026-06-18T00:00:00.010Z",
    duration: 10,
    usage: noUsage,
    children: [],
    sessionId: "s1",
    turnIndex: 0,
    signature: "sig",
    turns: [],
  };
}

/**
 * Minimal mock orchestrator exposing only the surface `asTool()` reads —
 * `name` and `execute()`. Captures the `execute()` call so the test can
 * assert how `asTool` resolved `sessionId` / `history` / input from the
 * tool payload. The `execute` impl returns a successful
 * `OrchestratorResult` unless `error` is supplied.
 */
function mockOrchestrator(options?: {
  name?: string;
  error?: AIError;
  data?: unknown;
}): {
  orchestrator: OrchestratorContract<unknown, unknown>;
  calls: { input: SupervisorInput; options: OrchestratorExecuteOptions<unknown> }[];
} {
  const calls: {
    input: SupervisorInput;
    options: OrchestratorExecuteOptions<unknown>;
  }[] = [];

  const execute = vi.fn(
    async (
      input: SupervisorInput,
      executeOptions: OrchestratorExecuteOptions<unknown>,
    ): Promise<OrchestratorResult<unknown>> => {
      calls.push({ input, options: executeOptions });

      return {
        data: options?.error ? undefined : (options?.data ?? { ok: true }),
        error: options?.error,
        usage: noUsage,
        report: makeReport(),
        sessionId: executeOptions.sessionId,
        turnIndex: 0,
      };
    },
  );

  const orchestrator = {
    name: options?.name ?? "support",
    signature: "sig",
    version: undefined,
    execute,
  } as unknown as OrchestratorContract<unknown, unknown>;

  return { orchestrator, calls };
}

const passthroughObject = schema<Record<string, unknown>>((value) =>
  typeof value === "object" && value !== null
    ? { value: value as Record<string, unknown> }
    : { issues: [{ message: "expected an object" }] },
);

describe("orchestrator.asTool()", () => {
  it('"fresh" scope opens a new session and forwards the whole payload as input', async () => {
    const { orchestrator, calls } = mockOrchestrator();

    const tool = asTool(orchestrator, {
      name: "handle_support",
      description: "handles support",
      inputSchema: passthroughObject,
    });

    expect(tool.name).toBe("handle_support");

    const invocation = await tool.invoke({ message: "help me" });

    expect(invocation.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].options.sessionId).toMatch(/^session_/);
    expect(calls[0].options.history).toEqual([]);
    expect(calls[0].input).toEqual({ message: "help me" });
  });

  it('"shared" scope extracts sessionId + history and forwards the rest as input', async () => {
    const { orchestrator, calls } = mockOrchestrator();
    const history: Message[] = [{ role: "user", content: "earlier" }];

    const tool = asTool(orchestrator, {
      name: "handle_support",
      inputSchema: passthroughObject,
      sessionScope: "shared",
    });

    await tool.invoke({ sessionId: "sess_42", history, message: "continue" });

    expect(calls[0].options.sessionId).toBe("sess_42");
    expect(calls[0].options.history).toEqual(history);
    expect(calls[0].input).toEqual({ message: "continue" });
  });

  it('"shared" scope without a sessionId surfaces SupervisorFailedError as the tool cause', async () => {
    const { orchestrator } = mockOrchestrator();

    const tool = asTool(orchestrator, {
      name: "handle_support",
      inputSchema: passthroughObject,
      sessionScope: "shared",
    });

    const invocation = await tool.invoke({ message: "no session here" });

    expect(invocation.error).toBeDefined();
    expect(invocation.error?.code).toBe("TOOL_EXEC_FAILED");
    expect((invocation.error as { cause?: unknown }).cause).toBeInstanceOf(
      SupervisorFailedError,
    );
  });

  it("surfaces an orchestrator result error as ToolExecutionError with cause", async () => {
    const boom = new SupervisorFailedError("orchestrator blew up");
    const { orchestrator } = mockOrchestrator({ error: boom });

    const tool = asTool(orchestrator, {
      name: "handle_support",
      inputSchema: passthroughObject,
    });

    const invocation = await tool.invoke({ message: "go" });

    expect(invocation.error?.code).toBe("TOOL_EXEC_FAILED");
    expect((invocation.error as { cause?: unknown }).cause).toBe(boom);
  });

  it("defaults the tool name and description to the orchestrator identity", () => {
    const { orchestrator } = mockOrchestrator({ name: "refund-support" });

    const tool = asTool(orchestrator, {
      inputSchema: passthroughObject,
    });

    expect(tool.name).toBe("refund-support");
    expect(tool.description).toContain("refund-support");
  });
});
