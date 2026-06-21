import { describe, expect, it } from "vitest";
import type { OrchestratorEvent } from "../contracts/orchestrator/orchestrator-event.type";
import { createOrchestratorStream } from "./orchestrator-stream";

function turnStarting(turnIndex: number): OrchestratorEvent {
  return {
    type: "orchestrator.turn.starting",
    sessionId: "s1",
    turnIndex,
    runId: "run_1",
    rootRunId: "run_1",
  };
}

describe("createOrchestratorStream", () => {
  it("yields pushed events in order via async iteration", async () => {
    const { controller, stream } = createOrchestratorStream<string>();

    controller.push(turnStarting(0));
    controller.push(turnStarting(1));
    controller.end("done");

    const seen: number[] = [];
    for await (const event of stream) {
      if (event.type === "orchestrator.turn.starting") {
        seen.push(event.turnIndex);
      }
    }

    expect(seen).toEqual([0, 1]);
  });

  it("resolves result with the value passed to end()", async () => {
    const { controller, stream } = createOrchestratorStream<string>();

    controller.push(turnStarting(0));
    controller.end("final-result");

    await expect(stream.result).resolves.toBe("final-result");
  });

  it("invokes named handlers registered via on()", async () => {
    const { controller, stream } = createOrchestratorStream<string>();

    const seen: number[] = [];
    stream.on({
      "orchestrator.turn.starting": (event) => seen.push(event.turnIndex),
    });

    controller.push(turnStarting(7));
    controller.end("done");

    await stream.result;
    expect(seen).toEqual([7]);
  });

  it("rejects result and iteration when fail() is called", async () => {
    const { controller, stream } = createOrchestratorStream<string>();
    const boom = new Error("drift");

    controller.fail(boom);

    await expect(stream.result).rejects.toThrow("drift");
  });

  it("delivers an event awaited before it is pushed", async () => {
    const { controller, stream } = createOrchestratorStream<string>();
    const iterator = stream[Symbol.asyncIterator]();

    const pending = iterator.next();
    controller.push(turnStarting(42));

    const result = await pending;
    expect(result.done).toBe(false);
    expect((result.value as OrchestratorEvent & { turnIndex: number }).turnIndex).toBe(42);
  });

  it("a throwing stream handler does not crash the pipe", async () => {
    const { controller, stream } = createOrchestratorStream<string>();

    stream.on({
      "orchestrator.turn.starting": () => {
        throw new Error("handler bug");
      },
    });

    controller.push(turnStarting(0));
    controller.end("done");

    await expect(stream.result).resolves.toBe("done");
  });
});
