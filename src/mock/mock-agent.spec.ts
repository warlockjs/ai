import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import { tool } from "../tool/tool";
import { mockAgent } from "./mock-agent";

function schema<T>(
  validate: (value: unknown) => StandardSchemaV1.Result<T>,
): StandardSchemaV1<T> {
  return { "~standard": { version: 1, vendor: "test", validate } };
}

describe("mockAgent()", () => {
  it("defaults to an empty 'stop' response when no responses given", async () => {
    const a = mockAgent();
    const result = await a.execute("anything");
    expect(result.error).toBeUndefined();
    expect(result.text).toBe("");
    expect(result.report.status).toBe("completed");
  });

  it("scripts responses in the order they're provided", async () => {
    const a = mockAgent({
      responses: [
        { content: "first", finishReason: "stop" },
        { content: "second", finishReason: "stop" },
      ],
    });
    const r1 = await a.execute("hi");
    const r2 = await a.execute("again");
    expect(r1.text).toBe("first");
    expect(r2.text).toBe("second");
  });

  it("assigns the explicit name when provided", async () => {
    const a = mockAgent({ name: "writer" });
    expect(a.name).toBe("writer");
  });

  it("falls back to the deterministic anonymous fingerprint when name is omitted", async () => {
    const a = mockAgent();
    // Format: anon_<provider>_<model> — MockModel reports provider="mock"
    expect(a.name).toMatch(/^anon_mock_mock-model$/);
  });

  it("includes tool names in the anonymous fingerprint", async () => {
    const t1 = tool({
      name: "alpha",
      description: "a",
      input: schema<unknown>(v => ({ value: v })),
      execute: async () => "ok",
    });
    const t2 = tool({
      name: "beta",
      description: "b",
      input: schema<unknown>(v => ({ value: v })),
      execute: async () => "ok",
    });
    const a = mockAgent({ tools: [t1, t2] });
    expect(a.name).toBe("anon_mock_mock-model_alpha+beta");
  });

  it("two anonymous mockAgents with identical config produce the same name", () => {
    const a1 = mockAgent();
    const a2 = mockAgent();
    expect(a1.name).toBe(a2.name);
  });

  it("wires tools so the model can request them", async () => {
    let invoked = 0;
    const echo = tool({
      name: "echo",
      description: "echoes input",
      input: schema<{ value: string }>(raw => {
        if (raw && typeof raw === "object" && "value" in raw) {
          return {
            value: { value: String((raw as { value: unknown }).value) },
          };
        }

        return { issues: [{ message: "missing value" }] };
      }),
      execute: async ({ value }) => `echoed:${value}`,
    });

    const a = mockAgent({
      name: "tooluser",
      tools: [echo],
      responses: [
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "c1", name: "echo", input: { value: "hi" } }],
        },
        { content: "done", finishReason: "stop" },
      ],
    });

    const result = await a.execute("go");
    expect(result.error).toBeUndefined();
    const toolCalls = result.report.children.filter(c => c.type === "tool");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("echo");
    expect((toolCalls[0] as { output?: unknown }).output).toBe("echoed:hi");
    void invoked;
  });
});
