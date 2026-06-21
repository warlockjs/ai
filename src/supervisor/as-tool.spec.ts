import { describe, expect, it } from "vitest";
import { END } from "../contracts/end.type";
import { buildScriptedAgent, schema } from "./_test-helpers";
import { supervisor } from "./supervisor";

function makeScripted(name: string, description: string, content: string) {
  return buildScriptedAgent({
    name,
    description,
    responses: [{ content, finishReason: "stop" }],
  });
}

describe("supervisor.asTool()", () => {
  it("wraps the supervisor as a ToolContract", async () => {
    const writer = makeScripted("writer", "drafts", "written");
    const supervisorInstance = supervisor({
      name: "wrappable",
      intents: { writer },
      route: (ctx) => (ctx.iteration === 0 ? "writer" : END),
    });

    const tool = supervisorInstance.asTool({
      name: "run_supervisor",
      description: "runs the wrappable supervisor",
      inputSchema: schema<{ topic: string }>((value) => {
        if (
          typeof value === "object" &&
          value !== null &&
          typeof (value as { topic?: unknown }).topic === "string"
        ) {
          return { value: value as { topic: string } };
        }

        return { issues: [{ message: "expected { topic: string }" }] };
      }),
    });

    expect(tool.name).toBe("run_supervisor");
    expect(tool.description).toContain("wrappable");

    const invocation = await tool.invoke({ topic: "go" });

    expect(invocation.error).toBeUndefined();
  });

  it("surfaces supervisor errors as ToolExecutionError with cause", async () => {
    const worker = makeScripted("worker", "loops", "ok");

    const supervisorInstance = supervisor({
      name: "wrappable-failing",
      intents: { worker },
      route: () => "worker",
      maxIterations: 1,
    });

    const tool = supervisorInstance.asTool({
      name: "wrapper",
      inputSchema: schema<{ x: string }>((value) => {
        if (
          typeof value === "object" &&
          value !== null &&
          typeof (value as { x?: unknown }).x === "string"
        ) {
          return { value: value as { x: string } };
        }

        return { issues: [{ message: "expected { x: string }" }] };
      }),
    });

    const invocation = await tool.invoke({ x: "oops" });

    expect(invocation.error).toBeDefined();
    expect(invocation.error?.code).toBe("TOOL_EXEC_FAILED");
    expect((invocation.error as { cause?: unknown }).cause).toMatchObject({
      code: "SUPERVISOR_MAX_ITERATIONS",
    });
  });

  it("defaults tool name and description to supervisor identity", () => {
    const worker = makeScripted("worker", "ok", "ok");
    const supervisorInstance = supervisor({
      name: "default-named",
      intents: { worker },
      route: () => END,
    });

    const tool = supervisorInstance.asTool({
      inputSchema: schema<string>((value) =>
        typeof value === "string" ? { value } : { issues: [{ message: "expected string" }] },
      ),
    });

    expect(tool.name).toBe("default-named");
    expect(tool.description).toContain("default-named");
  });
});
