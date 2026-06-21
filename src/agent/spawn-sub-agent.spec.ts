import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import { MockSDK } from "../mock/mock-sdk";
import { spawnSubAgent } from "./spawn-sub-agent";

describe("spawnSubAgent", () => {
  it("runs a fresh agent on the subtask and returns its result", async () => {
    const model = MockSDK({
      responses: [{ content: "subtask done", finishReason: "stop" }],
    }).model({ name: "sub" });

    const result = await spawnSubAgent({
      name: "extractor",
      model,
      task: "Extract entities from the text",
    });

    expect(result.type).toBe("agent");
    expect(result.error).toBeUndefined();
    expect(result.text).toBe("subtask done");
    expect(result.report.name).toBe("extractor");
    expect(result.report.status).toBe("completed");
  });

  it("validates structured output against the provided schema", async () => {
    const model = MockSDK({
      responses: [{ content: '{"companies":["Acme"]}', finishReason: "stop" }],
    }).model({ name: "sub" });

    const schema: StandardSchemaV1<{ companies: string[] }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate(value: unknown) {
          const record = value as { companies?: unknown };
          if (Array.isArray(record?.companies)) {
            return { value: { companies: record.companies as string[] } };
          }
          return { issues: [{ message: "companies required" }] };
        },
      },
    };

    const result = await spawnSubAgent({
      name: "extractor",
      model,
      task: "List the companies",
      output: schema,
    });

    expect(result.data).toEqual({ companies: ["Acme"] });
  });

  it("enforces an isolated per-spawn token budget", async () => {
    const model = MockSDK({
      responses: [
        {
          content: "way too long",
          finishReason: "stop",
          usage: { input: 500, output: 500, total: 1000 },
        },
      ],
    }).model({ name: "sub" });

    const result = await spawnSubAgent({
      name: "capped",
      model,
      task: "Do a big thing",
      budget: { maxTokens: 10 },
    });

    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe("BUDGET_EXCEEDED");
  });

  it("propagates sessionId onto the spawned report tree", async () => {
    const model = MockSDK({
      responses: [{ content: "ok", finishReason: "stop" }],
    }).model({ name: "sub" });

    const result = await spawnSubAgent({
      name: "tagged",
      model,
      task: "anything",
      sessionId: "session-42",
    });

    expect(result.report.sessionId).toBe("session-42");
  });
});
