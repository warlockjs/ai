import { describe, expect, it } from "vitest";
import { END } from "../contracts/end.type";
import { buildScriptedAgent } from "./_test-helpers";
import { supervisor } from "./supervisor";

function makeScripted(name: string, description: string, content: string) {
  return buildScriptedAgent({
    name,
    description,
    responses: [{ content, finishReason: "stop" }],
  });
}

describe("supervisor.stream() — event parity with execute()", () => {
  it("for-await stream yields the same event ordering as execute .on() listeners", async () => {
    const writer = makeScripted("writer", "drafts", "hi");
    const executeSupervisor = supervisor({
      name: "stream-parity-exec",
      intents: { writer },
      route: ctx => (ctx.iteration === 0 ? "writer" : END),
    });

    const executeEvents: string[] = [];
    await executeSupervisor.execute("x", {
      on: {
        "supervisor.starting": () => executeEvents.push("supervisor.starting"),
        "supervisor.iteration.starting": () =>
          executeEvents.push("supervisor.iteration.starting"),
        "supervisor.iteration.completed": () =>
          executeEvents.push("supervisor.iteration.completed"),
        "supervisor.completed": () =>
          executeEvents.push("supervisor.completed"),
      },
    });

    // Fresh instance so instance-level listeners registered on the first
    // supervisor don't bleed into the stream run.
    const streamSupervisor = supervisor({
      name: "stream-parity-stream",
      intents: {
        writer: buildScriptedAgent({
          name: "writer",
          description: "drafts",
          responses: [{ content: "hi", finishReason: "stop" }],
        }),
      },
      route: ctx => (ctx.iteration === 0 ? "writer" : END),
    });

    const interesting = new Set([
      "supervisor.starting",
      "supervisor.iteration.starting",
      "supervisor.iteration.completed",
      "supervisor.completed",
    ]);
    const streamEvents: string[] = [];
    const stream = streamSupervisor.stream("x");

    for await (const event of stream) {
      if (interesting.has(event.type)) {
        streamEvents.push(event.type);
      }
    }

    expect(streamEvents).toEqual(executeEvents);
  });

  it("for-await iteration yields typed events in order", async () => {
    const writer = makeScripted("writer", "drafts", "hi");
    const supervisorInstance = supervisor({
      name: "stream-iter",
      intents: { writer },
      route: ctx => (ctx.iteration === 0 ? "writer" : END),
    });

    const stream = supervisorInstance.stream("x");
    const seen: string[] = [];

    for await (const event of stream) {
      seen.push(event.type);
    }

    expect(seen[0]).toBe("supervisor.starting");
    expect(seen[seen.length - 1]).toBe("supervisor.completed");
    expect(seen).toContain("supervisor.iteration.completed");
  });

  it("resolves stream.result with the final SupervisorResult", async () => {
    const writer = makeScripted("writer", "drafts", "hi");
    const supervisorInstance = supervisor({
      name: "stream-result",
      intents: { writer },
      route: ctx => (ctx.iteration === 0 ? "writer" : END),
    });

    const stream = supervisorInstance.stream("x");
    const result = await stream.result;

    expect(result.type).toBe("supervisor");
    expect(result.report.status).toBe("completed");
  });
});
