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

describe("supervisor — cancellation", () => {
  it("aborts between iterations when the signal fires", async () => {
    const worker = makeScripted("worker", "loops", "ok");
    const controller = new AbortController();

    const supervisorInstance = supervisor({
      name: "cancel-between",
      intents: { worker },
      // Force a pause at the start of each routing decision so the
      // abort signal has time to land before the next iteration
      // begins. Between-iteration cancellation is the supervisor's
      // guaranteed cancellation point.
      route: async ctx => {
        await new Promise(resolve => setTimeout(resolve, 10));
        if (ctx.iteration === 1) {
          controller.abort("user");
        }
        return "worker";
      },
      maxIterations: 50,
    });

    const result = await supervisorInstance.execute("x", {
      signal: controller.signal,
    });

    expect(result.error?.code).toBe("SUPERVISOR_CANCELLED");
    expect(result.report.status).toBe("cancelled");
    expect(result.report.terminatedBy).toBe("cancelled");
    expect(typeof result.report.cancelledAt).toBe("string");
    expect(result.report.snapshots.length).toBeGreaterThan(0);
  });

  it("returns normally (no throw) when cancelled pre-execution", async () => {
    const worker = makeScripted("worker", "ok", "ok");

    const supervisorInstance = supervisor({
      name: "cancel-pre",
      intents: { worker },
      route: () => "worker",
    });

    const controller = new AbortController();
    controller.abort("before-start");

    const result = await supervisorInstance.execute("x", {
      signal: controller.signal,
    });

    expect(result.error?.code).toBe("SUPERVISOR_CANCELLED");
    expect(result.report.status).toBe("cancelled");
    expect(result.report.snapshots).toHaveLength(0);
  });

  it("emits supervisor.cancelled event", async () => {
    const worker = makeScripted("worker", "ok", "ok");
    const controller = new AbortController();

    const supervisorInstance = supervisor({
      name: "cancel-event",
      intents: { worker },
      route: async ctx => {
        await new Promise(resolve => setTimeout(resolve, 5));
        if (ctx.iteration === 0) {
          controller.abort("stop");
        }
        return "worker";
      },
      maxIterations: 50,
    });

    let cancelledPayload: { cancelledAt: string; reason?: string } | undefined;

    supervisorInstance.on("supervisor.cancelled", payload => {
      cancelledPayload = payload;
    });

    await supervisorInstance.execute("x", { signal: controller.signal });

    expect(cancelledPayload).toBeDefined();
    expect(cancelledPayload?.reason).toBe("stop");
  });

  it("route callback async with slow delay — still cancellable between iterations", async () => {
    const worker = makeScripted("worker", "ok", "ok");

    const supervisorInstance = supervisor({
      name: "cancel-async-route",
      intents: { worker },
      route: async ctx => {
        // Simulate some async decision time
        await new Promise(resolve => setTimeout(resolve, 5));
        return ctx.iteration >= 10 ? END : "worker";
      },
      maxIterations: 50,
    });

    const controller = new AbortController();
    const promise = supervisorInstance.execute("x", {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 15);

    const result = await promise;

    expect(result.report.status).toBe("cancelled");
  });
});
