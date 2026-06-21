import { describe, expect, it } from "vitest";
import type { WorkflowInstance } from "../contracts/workflow/workflow.contract";
import { ToolExecutionError, WorkflowError } from "../errors";
import { mockAgent } from "../mock/mock-agent";
import { passthrough, schema } from "./_test-helpers";
import { asTool } from "./as-tool";
import { step } from "./step";
import { workflow } from "./workflow";

describe("workflow.asTool()", () => {
  it("round-trips: agent invokes workflow-as-tool and gets data as tool output", async () => {
    const wf = workflow<{ topic: string }, { answer: string }>({
      name: "answer-bot",
      steps: [
        step({
          name: "respond",
          run: ctx => {
            const topic = (ctx.input as { topic: string }).topic;
            ctx.state.answer = `re: ${topic}`;
          },
        }),
      ],
      output: { extract: ctx => ({ answer: ctx.state.answer as string }) },
    });

    const wfTool = wf.asTool({
      description: "Bot that answers a topic",
      inputSchema: schema<{ topic: string }>(raw => {
        if (raw && typeof raw === "object" && "topic" in raw) {
          return {
            value: { topic: String((raw as { topic: unknown }).topic) },
          };
        }

        return { issues: [{ message: "missing topic" }] };
      }),
    });

    expect(wfTool.name).toBe("answer-bot");
    expect(wfTool.description).toBe("Bot that answers a topic");

    const a = mockAgent({
      name: "caller",
      tools: [wfTool],
      responses: [
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            { id: "c1", name: "answer-bot", input: { topic: "weather" } },
          ],
        },
        { content: "done", finishReason: "stop" },
      ],
    });

    const result = await a.execute("go");
    expect(result.error).toBeUndefined();
    const toolCalls = result.report.children.filter(c => c.type === "tool");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("answer-bot");
    expect((toolCalls[0] as { output?: unknown }).output).toEqual({
      answer: "re: weather",
    });
  });

  it("workflow error surfaces as ToolExecutionError with cause set to the WorkflowError subclass", async () => {
    const wf = workflow<{ x: number }, unknown>({
      name: "explodes",
      steps: [
        step({
          name: "boom",
          run: () => {
            throw new Error("intentional");
          },
        }),
      ],
    });

    const wfTool = wf.asTool({
      inputSchema: passthrough,
    });

    const result = await wfTool.invoke({ x: 1 });
    expect(result.error).toBeInstanceOf(ToolExecutionError);
    const err = result.error as ToolExecutionError;
    expect(err.toolName).toBe("explodes");
    // The cause should be a WorkflowError subclass (StepFailedError).
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(WorkflowError);
  });

  it("uses a default description when one isn't provided", async () => {
    const wf = workflow<unknown, unknown>({
      name: "no-desc",
      steps: [step({ name: "noop", run: () => {} })],
    });

    const wfTool = wf.asTool({ inputSchema: passthrough });
    expect(wfTool.description).toContain("no-desc");
  });

  it("throws WorkflowError if the workflow has no name (defensive — workflow() also rejects)", () => {
    // workflow() rejects empty names at validate time — we exercise
    // the asTool() guard directly to lock behavior in case the
    // upstream check is ever relaxed.
    const fakeWorkflow = {
      name: "",
      signature: "x",
      execute: async () => ({}) as never,
      resume: async () => ({}) as never,
      on: () => () => {},
      off: () => {},
      asTool: () => ({}) as never,
    } as unknown as WorkflowInstance<unknown, unknown>;

    expect(() => asTool(fakeWorkflow, { inputSchema: passthrough })).toThrow(
      WorkflowError,
    );
  });
});
