import { describe, expect, it, vi } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Message } from "../contracts/conversation-message.type";
import type {
  ModelCallOptions,
  ModelContract,
  ModelResponse,
  ModelStreamChunk,
} from "../contracts/model.contract";
import type { AgentSnapshot } from "../contracts/agent/agent-snapshot.type";
import { AgentDriftError } from "../errors";
import { memory as snapshotMemory } from "../snapshot/memory";
import { tool } from "../tool/tool";
import { agent } from "./agent";

/** Typed in-memory snapshot store for these agent durable tests. */
function agentStore() {
  return snapshotMemory<AgentSnapshot>();
}

// ---------------------------------------------------------------------------
// Hand-rolled Standard Schema helper (mirrors agent.spec.ts)
// ---------------------------------------------------------------------------

function makeSchema<T>(
  validate: (value: unknown) => StandardSchemaV1.Result<T>,
): StandardSchemaV1<T> {
  return { "~standard": { version: 1, vendor: "test", validate } };
}

const stringSchema = makeSchema<string>((v) =>
  typeof v === "string" ? { value: v } : { issues: [{ message: "expected string" }] },
);

// ---------------------------------------------------------------------------
// A controllable model whose second `complete()` THROWS while
// `shouldFail` is true. The first trip requests a tool; once the failure
// is "fixed" (shouldFail flipped off) a re-issued second trip returns a
// natural stop. Models a crash mid-run (trip 1's model call) followed by
// a clean resume.
// ---------------------------------------------------------------------------

class FlakyModel implements ModelContract {
  public readonly provider = "mock";
  public readonly name: string;

  /** Per-trip `complete()` invocation counter — proves no replay. */
  public completeCalls = 0;
  /** Flip to `false` before resume so the re-issued trip succeeds. */
  public shouldFail = true;

  public constructor(name = "flaky") {
    this.name = name;
  }

  public async complete(
    _messages: Message[],
    _options?: ModelCallOptions,
  ): Promise<ModelResponse> {
    this.completeCalls++;

    // Trip 0 — request the tool. Always succeeds, gets checkpointed.
    if (this.completeCalls === 1) {
      return {
        content: "",
        finishReason: "tool_calls",
        usage: { input: 100, output: 20, total: 120 },
        toolCalls: [{ id: "call_1", name: "spyTool", input: "go" }],
      };
    }

    // Trip 1+ — crash while the failure is unresolved.
    if (this.shouldFail) {
      throw new Error("boom: trip 1 crashed");
    }

    return {
      content: "final answer",
      finishReason: "stop",
      usage: { input: 50, output: 30, total: 80 },
    };
  }

  // eslint-disable-next-line require-yield
  public async *stream(): AsyncIterable<ModelStreamChunk> {
    throw new Error("stream not used in this spec");
  }
}

describe("agent — durable mid-run crash-resume", () => {
  it("checkpoints after a settled trip and resumes only the failed-and-after trips", async () => {
    const store = agentStore();
    const spy = vi.fn(async (input: string) => `tool:${input}`);
    const spyTool = tool({
      name: "spyTool",
      description: "spy",
      input: stringSchema,
      execute: spy,
    });

    const model = new FlakyModel();
    const writer = agent({
      name: "writer",
      model,
      tools: [spyTool],
      durable: { store },
    });

    // First run — trip 0 dispatches the tool + checkpoints, trip 1 crashes.
    const first = await writer.execute("research X", { runId: "run-1" });

    expect(first.error).toBeDefined();
    expect(first.report.status).toBe("failed");
    // The tool was dispatched exactly once on the first run.
    expect(spy).toHaveBeenCalledTimes(1);

    // A snapshot exists carrying the completed tool-call trip.
    const snapshot = await store.load("run-1");
    expect(snapshot).toBeDefined();
    expect(snapshot!.runId).toBe("run-1");
    expect(snapshot!.trips.length).toBeGreaterThanOrEqual(1);
    expect(snapshot!.toolCalls).toHaveLength(1);

    // Fix the failure cause, then resume.
    model.shouldFail = false;
    const recovered = await writer.resume("run-1");

    // (a) The resume completed cleanly.
    expect(recovered.error).toBeUndefined();
    expect(recovered.report.status).toBe("completed");
    expect(recovered.text).toBe("final answer");

    // (b) The earlier tool was NOT re-invoked on resume.
    expect(spy).toHaveBeenCalledTimes(1);

    // The settled trips (the tool-call trip 0 + the recorded failed trip 1)
    // are never re-issued — their model calls are not replayed. The first
    // run made 2 complete() calls (trip 0 + the crashing trip 1); the
    // resume continues at the next trip → exactly 1 more call.
    expect(model.completeCalls).toBe(3);
  });

  it("does not double-count usage across a resume", async () => {
    const store = agentStore();
    const spyTool = tool({
      name: "spyTool",
      description: "spy",
      input: stringSchema,
      execute: async (input: string) => `tool:${input}`,
    });

    const model = new FlakyModel();
    const writer = agent({
      name: "usage-writer",
      model,
      tools: [spyTool],
      durable: { store },
    });

    await writer.execute("go", { runId: "run-usage" });

    model.shouldFail = false;
    const recovered = await writer.resume("run-usage");

    // Trip 0 = 120 total, the failed trip 1 = 0 (threw before usage), the
    // resumed trip 1 = 80. The completed run totals 120 + 80 = 200 — trip
    // 0's tokens are counted exactly once, never replayed.
    expect(recovered.usage.input).toBe(150);
    expect(recovered.usage.output).toBe(50);
    expect(recovered.usage.total).toBe(200);
  });

  it("short-circuits a completed-run resume to the stored result", async () => {
    const store = agentStore();
    const model = new FlakyModel();
    model.shouldFail = false; // run completes on the first execute

    const writer = agent({
      name: "completer",
      model,
      tools: [
        tool({
          name: "spyTool",
          description: "spy",
          input: stringSchema,
          execute: async (input: string) => `tool:${input}`,
        }),
      ],
      durable: { store },
    });

    const first = await writer.execute("go", { runId: "run-done" });
    expect(first.report.status).toBe("completed");

    const callsAfterFirst = model.completeCalls;

    const resumed = await writer.resume("run-done");

    // The resume re-returned the stored result without re-running the model.
    expect(resumed.report.status).toBe("completed");
    expect(resumed.text).toBe("final answer");
    expect(model.completeCalls).toBe(callsAfterFirst);
  });

  it("refuses to resume against a structurally drifted definition unless forced", async () => {
    const store = agentStore();
    const model = new FlakyModel();

    const writer = agent({
      name: "drifter",
      model,
      tools: [
        tool({
          name: "spyTool",
          description: "spy",
          input: stringSchema,
          execute: async (input: string) => `tool:${input}`,
        }),
      ],
      durable: { store },
    });

    await writer.execute("go", { runId: "run-drift" });

    // A structurally different agent — extra tool changes the signature.
    // Its model is pre-advanced past trip 0 (completeCalls=1, no fail) so a
    // forced resume's re-issued trip returns a natural stop.
    const driftModel = new FlakyModel();
    driftModel.completeCalls = 1;
    driftModel.shouldFail = false;

    const drifted = agent({
      name: "drifter",
      model: driftModel,
      tools: [
        tool({
          name: "spyTool",
          description: "spy",
          input: stringSchema,
          execute: async (input: string) => `tool:${input}`,
        }),
        tool({
          name: "extraTool",
          description: "extra",
          input: stringSchema,
          execute: async () => "x",
        }),
      ],
      durable: { store },
    });

    await expect(drifted.resume("run-drift")).rejects.toBeInstanceOf(AgentDriftError);

    // `force: true` bypasses the drift check and runs the resumed tail.
    const forced = await drifted.resume("run-drift", { force: true });
    expect(forced.report.runId).toBe("run-drift");
  });

  it("is a no-op without `durable` — no snapshot written, behavior unchanged", async () => {
    const store = agentStore();
    const model = new FlakyModel();
    model.shouldFail = false;

    // No `durable` on the config — even with a default store unused here.
    const plain = agent({
      name: "plain",
      model,
      tools: [
        tool({
          name: "spyTool",
          description: "spy",
          input: stringSchema,
          execute: async (input: string) => `tool:${input}`,
        }),
      ],
    });

    const result = await plain.execute("go", { runId: "run-plain" });

    expect(result.report.status).toBe("completed");
    // Nothing was persisted — the explicit store was never wired in.
    expect(await store.load("run-plain")).toBeUndefined();
  });
});
