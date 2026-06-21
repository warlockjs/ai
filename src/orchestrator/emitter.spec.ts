import { describe, expect, it, vi } from "vitest";
import type { EventIdentity } from "../contracts/events/event-identity.type";
import { OrchestratorEmitter } from "./emitter";

const identity: EventIdentity = { runId: "run_1", rootRunId: "run_1" };

describe("OrchestratorEmitter — three-tier fan-out", () => {
  it("fires definition, instance, and per-call handlers in tier order", () => {
    const order: string[] = [];

    const emitter = new OrchestratorEmitter({
      "orchestrator.turn.starting": () => order.push("definition"),
    });

    emitter.on("orchestrator.turn.starting", () => order.push("instance"));

    emitter.emit(
      "orchestrator.turn.starting",
      { sessionId: "s1", turnIndex: 0 },
      identity,
      { "orchestrator.turn.starting": () => order.push("per-call") },
    );

    expect(order).toEqual(["definition", "instance", "per-call"]);
  });

  it("stamps run identity onto the payload every tier receives", () => {
    const seen: EventIdentity[] = [];

    const emitter = new OrchestratorEmitter();
    emitter.on("orchestrator.turn.completed", (event) => {
      seen.push({ runId: event.runId, rootRunId: event.rootRunId });
    });

    const fullPayload = emitter.emit(
      "orchestrator.turn.completed",
      { sessionId: "s1", turnIndex: 3 },
      identity,
    );

    expect(fullPayload.runId).toBe("run_1");
    expect(fullPayload.rootRunId).toBe("run_1");
    expect(seen).toEqual([identity]);
  });

  it("returns an unsubscribe function from on() that stops the handler", () => {
    const handler = vi.fn();
    const emitter = new OrchestratorEmitter();

    const off = emitter.on("orchestrator.turn.starting", handler);
    emitter.emit(
      "orchestrator.turn.starting",
      { sessionId: "s1", turnIndex: 0 },
      identity,
    );

    off();
    emitter.emit(
      "orchestrator.turn.starting",
      { sessionId: "s1", turnIndex: 1 },
      identity,
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("off() removes a previously-registered instance handler", () => {
    const handler = vi.fn();
    const emitter = new OrchestratorEmitter();

    emitter.on("orchestrator.checkpoint.persisted", handler);
    emitter.off("orchestrator.checkpoint.persisted", handler);

    emitter.emit(
      "orchestrator.checkpoint.persisted",
      { sessionId: "s1", turnIndex: 1 },
      identity,
    );

    expect(handler).not.toHaveBeenCalled();
  });

  it("swallows a throwing handler so later tiers still fire", () => {
    const order: string[] = [];

    const emitter = new OrchestratorEmitter({
      "orchestrator.turn.starting": () => {
        order.push("definition");
        throw new Error("listener bug");
      },
    });
    emitter.on("orchestrator.turn.starting", () => order.push("instance"));

    expect(() =>
      emitter.emit(
        "orchestrator.turn.starting",
        { sessionId: "s1", turnIndex: 0 },
        identity,
      ),
    ).not.toThrow();

    expect(order).toEqual(["definition", "instance"]);
  });
});
